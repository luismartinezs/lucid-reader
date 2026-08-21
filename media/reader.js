/* ==========================================================================
   Lucid Reader - webview runtime
   --------------------------------------------------------------------------
   Responsibilities, in order of importance:
     1. Turn a config object into CSS custom properties + body data-attributes.
     2. Own the reading aids that need layout knowledge (focus, ruler, bionic).
     3. Keep navigation state: outline, scrollspy, progress, position memory.

   Two invariants worth knowing before editing:
     - `state.pristine` holds the HTML exactly as the extension sent it. Every
       DOM transform (bionic, sentence wrapping) is destructive, so any change
       to a transform resets from pristine and re-applies the whole chain. This
       is why toggling bionic twice cannot corrupt the document.
     - Settings changes are applied optimistically here *and* sent to the
       extension. The echoed config broadcast is a confirmation, not the source
       of truth for this frame, which is what makes keypresses feel instant.
   ========================================================================== */

(() => {
  'use strict';

  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);

  /**
   * Attaches a listener only if the element exists.
   *
   * The webview HTML and this script are two files that can disagree. VS Code
   * builds the HTML in the extension host, which keeps the previously loaded
   * copy of out/webview.js until the window is reloaded, while the webview
   * fetches media/reader.js from disk on every open. Reinstalling in place
   * therefore pairs an old shell with a new script, and an element added in
   * the same change is missing. Before this helper, that threw during startup
   * wiring, which runs above the `ready` post, so the extension never sent the
   * document and the reader showed an empty background.
   */
  const on = (id, type, handler) => {
    $(id)?.addEventListener(type, handler);
  };

  const body = document.body;
  const scroller = $('scroller');
  const doc = $('doc');

  const state = {
    cfg: null,
    pristine: '',
    headings: [],
    words: 0,
    title: '',
    frontMatter: null,
    blocks: [],
    focusEl: null,
    manualIndex: 0,
    autoScroll: false,
    autoRaf: 0,
    autoLast: 0,
    pointer: { x: 0, y: 0, active: false },
    findHits: [],
    findIndex: 0,
    cursorTimer: 0,
    restorePending: 0,
  };

  /* ------------------------------------------------------------- utilities */

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  const setPath = (obj, path, value) => {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o[k] = o[k] ?? {}), obj);
    target[last] = value;
  };

  /** Optimistic local apply + persist request. See the header note on latency. */
  const setSetting = (path, value, label) => {
    setPath(state.cfg, path, value);
    applyConfig(state.cfg);
    vscode.postMessage({ type: 'set', key: path, value });
    if (label) {
      toast(label);
    }
  };

  let toastTimer = 0;
  const toast = (text) => {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1200);
  };

  const cycleValue = (list, current, step = 1) => {
    const i = list.indexOf(current);
    return list[(i < 0 ? 0 : i + step + list.length) % list.length];
  };

  /* ---------------------------------------------------------- config -> CSS */

  const NUMERALS = {
    lining: 'lining-nums proportional-nums',
    oldstyle: 'oldstyle-nums proportional-nums',
    tabular: 'lining-nums tabular-nums',
  };

  /* Kept in sync with the min/max/default on `lucid.layout.tocWidth` in package.json. */
  const TOC_MIN_REM = 10;
  const TOC_MAX_REM = 40;
  const TOC_DEFAULT_REM = 15.5;

  const FALLBACK_CODE_FONT =
    "var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace)";

  const applyConfig = (cfg) => {
    state.cfg = cfg;
    const t = cfg.typography;
    const th = cfg.theme;
    const l = cfg.layout;
    const r = cfg.reading;
    const root = document.documentElement;

    const varMap = {
      '--font-body': t.fontFamily,
      '--font-heading': t.headingFontFamily.trim() || t.fontFamily,
      '--font-code': t.codeFontFamily.trim() || FALLBACK_CODE_FONT,
      '--fs': `${t.fontSize}px`,
      '--fw': String(t.fontWeight),
      '--lh': String(t.lineHeight),
      '--measure': String(t.measure),
      '--ls': `${t.letterSpacing}em`,
      '--ws': `${t.wordSpacing}em`,
      '--para-space': t.paragraphIndent > 0 ? '0em' : `${t.paragraphSpacing}em`,
      '--para-indent': `${t.paragraphIndent}em`,
      '--align': t.textAlign,
      '--hyphens': t.hyphens ? 'auto' : 'manual',
      '--numerals': NUMERALS[t.numerals] ?? NUMERALS.lining,
      '--heading-scale': String(t.headingScale),
      '--heading-wrap': t.balanceHeadings ? 'balance' : 'normal',
      '--wrap-mode': t.prettyWrap ? 'pretty' : 'normal',
      '--pad-top': `${l.paddingTop}rem`,
      '--pad-bottom': `${l.paddingBottom}vh`,
      '--img-max': String(l.maxImageHeight),
      '--focus-dim': String(r.focusDim),
      '--focus-blur': `${r.focusBlur}px`,
      '--bionic-op': String(r.bionicOpacity),
      '--ruler-h': String(r.rulerHeight),
      '--ruler-op': String(r.rulerOpacity),
      '--toc-width': `${l.tocWidth ?? TOC_DEFAULT_REM}rem`,
      '--scroll-behavior': l.smoothScroll ? 'smooth' : 'auto',
    };
    for (const [key, value] of Object.entries(varMap)) {
      root.style.setProperty(key, value);
    }

    body.dataset.theme = th.name;

    // MUST be set on <body>, not on <html>.
    //
    // A var() reference is substituted against the element the custom property
    // is *declared on*, not the element that consumes it. The theme palette is
    // declared on <body> (`body[data-theme='...']`), while <html> only ever
    // carries the `:root` paper fallback. Setting `--heading-color: var(--fg)`
    // on <html> therefore froze it to the light theme's near-black text, and
    // every heading rendered invisible on a dark background. Setting it here
    // resolves against the palette that is actually in effect.
    root.style.removeProperty('--heading-color');
    body.style.setProperty(
      '--heading-color',
      th.headingColor === 'accent'
        ? 'var(--accent)'
        : th.headingColor === 'muted'
          ? 'var(--muted)'
          : 'var(--heading-fg)',
    );

    body.dataset.links = th.linkStyle;
    body.dataset.codeStyle = th.codeStyle;
    body.dataset.align = l.align;
    body.dataset.table = l.tableStyle;
    body.dataset.code = l.codeBlocks;
    body.dataset.wrapCode = l.wrapCode ? 'on' : 'off';
    body.dataset.progress = l.showProgress ? 'on' : 'off';
    body.dataset.hud = l.showHud ? 'on' : 'off';
    body.dataset.crumb = l.stickyHeading ? 'on' : 'off';
    body.dataset.focus = r.focusMode;
    body.dataset.ruler = r.ruler;
    body.dataset.bionic = r.bionic ? 'on' : 'off';
    body.dataset.dropcap = t.dropCap ? 'on' : 'off';
    body.dataset.hanging = t.hangingPunctuation ? 'on' : 'off';
    body.dataset.hoverHighlight = r.highlightOnHover ? 'on' : 'off';

    // Text contrast softening: mix the theme foreground toward the background.
    if (th.textContrast < 1) {
      doc.style.color = `color-mix(in srgb, var(--fg) ${Math.round(th.textContrast * 100)}%, var(--bg))`;
    } else {
      doc.style.color = '';
    }

    applyCustomColors(th.customColors);
    applyTransforms();
    layoutToc();
    updateChrome();
    updateFocus();
  };

  const COLOR_VARS = {
    background: '--bg',
    surface: '--surface',
    text: '--fg',
    heading: '--heading-fg',
    muted: '--muted',
    accent: '--accent',
    rule: '--rule',
    codeBackground: '--code-bg',
    highlight: '--highlight',
  };

  /**
   * Two functions write inline custom properties onto <body>: this one, and
   * applyTheme's `--heading-color`. They must not overlap. `--heading-color`
   * is deliberately absent from COLOR_VARS, because the wipe loop below would
   * clear it on every config change, and because `--heading-color` holds a
   * `var()` reference to `--heading-fg`, which IS in the map. Adding a key
   * here that another function also writes would make the two clobber each
   * other in call order.
   */
  const applyCustomColors = (colors) => {
    for (const cssVar of Object.values(COLOR_VARS)) {
      body.style.removeProperty(cssVar);
    }
    if (!colors) {
      return;
    }
    for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
      const value = colors[key];
      if (typeof value === 'string' && value.trim()) {
        body.style.setProperty(cssVar, value.trim());
      }
    }
  };

  /* ------------------------------------------------------------- rendering */

  const renderFrontMatter = () => {
    if (!state.frontMatter || !state.cfg.layout.showFrontMatter) {
      return '';
    }
    const rows = state.frontMatter
      .map(
        ([k, v]) =>
          `<dt>${escapeText(k)}</dt><dd>${escapeText(v)}</dd>`,
      )
      .join('');
    return `<dl id="front-matter">${rows}</dl>`;
  };

  const escapeText = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const setDocument = (msg) => {
    const previousRatio = scrollRatio();
    state.pristine = msg.html;
    state.headings = msg.headings || [];
    state.words = msg.words || 0;
    state.title = msg.title || '';
    state.frontMatter = msg.frontMatter;
    state.cfg = msg.config;

    applyConfig(msg.config);
    buildToc();

    if (typeof msg.restoreRatio === 'number' && msg.restoreRatio > 0) {
      restoreRatio(msg.restoreRatio);
    } else if (previousRatio > 0) {
      restoreRatio(previousRatio);
    }
    updateChrome();
  };

  /**
   * Rebuild the article from pristine HTML and re-apply every DOM transform.
   * Order matters: sentence wrapping introduces the spans that bionic then
   * walks into, so it must run first.
   */
  const applyTransforms = () => {
    if (!state.pristine) {
      return;
    }
    doc.innerHTML = renderFrontMatter() + state.pristine;

    if (state.cfg.reading.focusMode === 'sentence') {
      wrapSentences(doc);
    }
    if (state.cfg.reading.bionic) {
      applyBionic(doc, state.cfg.reading.bionicStrength);
    }
    syncWrapButtons();
    state.blocks = collectBlocks();
    state.focusEl = null;
  };

  /**
   * The caption Wrap button is a view onto `lucid.layout.wrapCode`, which is a
   * document-wide setting, not per-block state. Every button therefore shows
   * the same label, and pressing one goes through setSetting() like any other
   * control: written to settings.json, broadcast to every open reader in every
   * window, and picked up by windows opened later.
   *
   * Called after applyTransforms(), because that rebuilds the article from
   * pristine HTML and hands back freshly parsed buttons with the default label.
   */
  const syncWrapButtons = () => {
    const on = !!state.cfg?.layout.wrapCode;
    for (const button of doc.querySelectorAll('.code-wrap')) {
      button.textContent = on ? 'Unwrap' : 'Wrap';
      button.title = on ? 'Stop wrapping long code lines' : 'Wrap long code lines';
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };

  const BLOCK_SELECTOR =
    'p, li, blockquote, h1, h2, h3, h4, h5, h6, figure.code, .table-wrap, hr';

  /**
   * Focus and j/k navigation operate on *leaf* blocks, not on top-level
   * children. Dimming a whole 40-item list because the reader is on item 3
   * defeats the point of focus mode, so a container that holds another
   * candidate is skipped in favour of the things inside it.
   */
  const collectBlocks = () => {
    const all = Array.from(doc.querySelectorAll(BLOCK_SELECTOR));
    const leaves = [];
    for (const el of all) {
      if (el.closest('#front-matter') || el.querySelector(BLOCK_SELECTOR)) {
        continue;
      }
      if (el.getClientRects().length === 0) {
        continue;
      }
      el.classList.add('dimmable');
      leaves.push(el);
    }
    return leaves;
  };

  const TEXT_HOSTS = 'P, LI, BLOCKQUOTE, TD, TH, DD, .callout';

  const walkTextNodes = (root, fn) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent || parent.closest('pre, code, #front-matter, .fn-num')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!parent.closest(TEXT_HOSTS)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    nodes.forEach(fn);
  };

  /**
   * Bionic reading: bold the leading fraction of each word.
   * Fraction rounds up so 3-letter words get 2 bold characters, which is what
   * makes short function words still read as anchors.
   */
  const applyBionic = (root, strength) => {
    walkTextNodes(root, (node) => {
      const frag = document.createDocumentFragment();
      const parts = node.nodeValue.split(/(\s+)/);
      for (const part of parts) {
        if (!part || /^\s+$/.test(part) || !/[\p{L}\p{N}]/u.test(part)) {
          frag.appendChild(document.createTextNode(part));
          continue;
        }
        const letters = part.length;
        const cut = clamp(Math.ceil(letters * strength), 1, letters);
        const b = document.createElement('b');
        b.className = 'bionic';
        b.textContent = part.slice(0, cut);
        frag.appendChild(b);
        frag.appendChild(document.createTextNode(part.slice(cut)));
      }
      node.parentNode.replaceChild(frag, node);
    });
  };

  const SENTENCE_RE = /[^.!?…]+(?:[.!?…]+["'”’)\]]*\s*|$)/gu;

  const wrapSentences = (root) => {
    walkTextNodes(root, (node) => {
      const chunks = node.nodeValue.match(SENTENCE_RE);
      if (!chunks || chunks.length < 2) {
        return;
      }
      const frag = document.createDocumentFragment();
      for (const chunk of chunks) {
        const span = document.createElement('span');
        span.className = 'sentence';
        span.textContent = chunk;
        frag.appendChild(span);
      }
      node.parentNode.replaceChild(frag, node);
    });
  };

  /* ------------------------------------------------------------------- TOC */

  const buildToc = () => {
    const list = $('toc-list');
    list.innerHTML = '';
    for (const h of state.headings) {
      if (h.level > state.cfg.layout.tocMaxDepth) {
        continue;
      }
      const li = document.createElement('li');
      li.dataset.level = String(h.level);
      const a = document.createElement('a');
      a.href = `#${h.slug}`;
      a.textContent = h.text;
      a.dataset.slug = h.slug;
      li.appendChild(a);
      list.appendChild(li);
    }
    layoutToc();
  };

  const layoutToc = () => {
    const mode = state.cfg.layout.toc;
    const count = state.headings.filter((h) => h.level <= state.cfg.layout.tocMaxDepth).length;
    const visible =
      mode === 'always' ? count > 0 : mode === 'never' ? false : count >= 3 && window.innerWidth >= 960;
    body.classList.toggle('toc-visible', visible);
    body.classList.toggle('toc-right', state.cfg.layout.tocSide === 'right');
  };

  /**
   * Drag-to-resize for the outline.
   *
   * The drag writes `--toc-width` straight onto <html> so the pane tracks the
   * pointer at screen rate, and only the pointerup commits through setSetting,
   * because every commit round-trips to the extension host and back as a config
   * broadcast. Committing per pointermove would queue one write to settings.json
   * per frame.
   *
   * Widths are stored in rem, not px, so an outline sized at one font size still
   * holds roughly the same number of outline entries after the reader font size
   * changes. The px-per-rem factor is read at drag start rather than assumed to
   * be 16, since the webview inherits the host's root font size.
   */
  const wireTocResize = () => {
    const grip = $('toc-resize');
    if (!grip) {
      return;
    }

    let dragging = false;
    let remPx = 16;
    let width = TOC_DEFAULT_REM;

    // The upper bound is whichever is smaller: the setting's own maximum (40rem)
    // or half the pane, so a wide drag in a narrow pane cannot leave the text
    // column with less room than the outline.
    const previewWidth = (rem) => {
      const paneMax = window.innerWidth / 2 / remPx;
      width = clamp(rem, TOC_MIN_REM, Math.max(TOC_MIN_REM, Math.min(TOC_MAX_REM, paneMax)));
      document.documentElement.style.setProperty('--toc-width', `${width}rem`);
    };

    const commitWidth = (label) => {
      setSetting('layout.tocWidth', Math.round(width * 100) / 100, label);
    };

    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      dragging = true;
      remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      width = state.cfg.layout.tocWidth ?? TOC_DEFAULT_REM;
      grip.setPointerCapture(event.pointerId);
      body.classList.add('toc-resizing');
    });

    grip.addEventListener('pointermove', (event) => {
      if (!dragging) {
        return;
      }
      const edge =
        state.cfg.layout.tocSide === 'right' ? window.innerWidth - event.clientX : event.clientX;
      previewWidth(edge / remPx);
    });

    const endDrag = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      body.classList.remove('toc-resizing');
      grip.releasePointerCapture?.(event.pointerId);
      commitWidth();
    };

    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);

    grip.addEventListener('dblclick', (event) => {
      event.preventDefault();
      width = TOC_DEFAULT_REM;
      commitWidth('outline width reset');
    });

    // Arrow keys give the same control without a pointer. The document-level
    // handler treats arrows as scrolling, so the event must stop here.
    grip.addEventListener('keydown', (event) => {
      const step =
        event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (step === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const towardsWider = state.cfg.layout.tocSide === 'right' ? -step : step;
      const current = state.cfg.layout.tocWidth ?? TOC_DEFAULT_REM;
      previewWidth(current + towardsWider * (event.shiftKey ? 0.25 : 1));
      commitWidth();
    });
  };

  /* ------------------------------------------------- progress, HUD, crumb */

  const scrollRatio = () => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    return max <= 0 ? 0 : clamp(scroller.scrollTop / max, 0, 1);
  };

  const restoreRatio = (ratio) => {
    // Layout is not final on the frame the HTML lands, so settle over two
    // animation frames before trusting scrollHeight.
    cancelAnimationFrame(state.restorePending);
    state.restorePending = requestAnimationFrame(() => {
      state.restorePending = requestAnimationFrame(() => {
        const max = scroller.scrollHeight - scroller.clientHeight;
        const previous = scroller.style.scrollBehavior;
        scroller.style.scrollBehavior = 'auto';
        scroller.scrollTop = max * ratio;
        scroller.style.scrollBehavior = previous;
        updateChrome();
      });
    });
  };

  const formatTime = (minutes) => {
    if (minutes < 1) {
      return '< 1 min left';
    }
    if (minutes < 60) {
      return `${Math.round(minutes)} min left`;
    }
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h} h ${m} min left`;
  };

  const updateChrome = () => {
    if (!state.cfg) {
      return;
    }
    const ratio = scrollRatio();
    $('progress-fill').style.width = `${(ratio * 100).toFixed(1)}%`;
    $('hud-progress').textContent = `${Math.round(ratio * 100)}%`;
    $('hud-words').textContent = `${state.words.toLocaleString()} words`;
    $('hud-time').textContent = formatTime(
      ((1 - ratio) * state.words) / state.cfg.reading.wordsPerMinute,
    );

    // Scrollspy: the active heading is the last one above the reading line.
    const line = window.innerHeight * 0.25;
    let active = null;
    for (const h of state.headings) {
      const el = document.getElementById(h.slug);
      if (el && el.getBoundingClientRect().top <= line) {
        active = h;
      } else if (el) {
        break;
      }
    }
    const crumb = $('crumb');
    if (active) {
      $('crumb-text').textContent = active.text;
      crumb.classList.toggle('show', scroller.scrollTop > 80);
    } else {
      crumb.classList.remove('show');
    }
    for (const a of $('toc-list').querySelectorAll('a')) {
      a.classList.toggle('active', Boolean(active) && a.dataset.slug === active.slug);
    }
  };

  /* ------------------------------------------------------- focus and ruler */

  const focusAnchorY = () => {
    const r = state.cfg.reading;
    if (r.focusFollows === 'mouse' && state.pointer.active) {
      return state.pointer.y;
    }
    return window.innerHeight * 0.42;
  };

  const blockNearest = (y) => {
    let best = null;
    let bestDist = Infinity;
    for (const el of state.blocks) {
      const rect = el.getBoundingClientRect();
      if (rect.height === 0) {
        continue;
      }
      const dist = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
      if (dist === 0) {
        break;
      }
    }
    return best;
  };

  /** Line boxes inside an element, via the rects a Range reports per line. */
  const lineRects = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return Array.from(range.getClientRects()).filter((r) => r.height > 0 && r.width > 1);
  };

  const updateFocus = () => {
    if (!state.cfg) {
      return;
    }
    const mode = state.cfg.reading.focusMode;
    const rulerMode = state.cfg.reading.ruler;
    const y = focusAnchorY();

    if (mode !== 'off') {
      const target =
        state.cfg.reading.focusFollows === 'manual'
          ? state.blocks[clamp(state.manualIndex, 0, state.blocks.length - 1)]
          : blockNearest(y);
      if (target !== state.focusEl) {
        state.focusEl?.classList.remove('is-focus');
        target?.classList.add('is-focus');
        state.focusEl = target ?? null;
      }
      if (mode === 'sentence' && state.focusEl) {
        const sentences = state.focusEl.querySelectorAll('.sentence');
        let hit = null;
        for (const s of sentences) {
          for (const rect of s.getClientRects()) {
            if (y >= rect.top && y <= rect.bottom) {
              hit = s;
              break;
            }
          }
          if (hit) {
            break;
          }
        }
        for (const s of doc.querySelectorAll('.sentence.is-focus-sentence')) {
          s.classList.remove('is-focus-sentence');
        }
        hit?.classList.add('is-focus-sentence');
      }
    } else if (state.focusEl) {
      state.focusEl.classList.remove('is-focus');
      state.focusEl = null;
    }

    if (rulerMode === 'off') {
      return;
    }

    // The ruler snaps to a real line box when there is one under the anchor,
    // so it never floats between two lines of text.
    const host = mode === 'off' ? blockNearest(y) : state.focusEl;
    let top = y - (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 0.6;
    let height =
      state.cfg.reading.rulerHeight *
      state.cfg.typography.lineHeight *
      state.cfg.typography.fontSize;
    if (host) {
      const rect = lineRects(host).find((r) => y >= r.top - 2 && y <= r.bottom + 2);
      if (rect) {
        top = rect.top - (height - rect.height) / 2;
      }
    }
    const ruler = $('ruler');
    ruler.style.top = `${top}px`;
    ruler.style.height = `${height}px`;

    if (rulerMode === 'spotlight') {
      $('spotlight-top').style.height = `${Math.max(0, top)}px`;
      $('spotlight-bottom').style.height = `${Math.max(0, window.innerHeight - top - height)}px`;
    }
  };

  /* --------------------------------------------------------------- scrolling */

  const scrollToY = (top, smooth = true) => {
    scroller.scrollTo({
      top,
      behavior: smooth && state.cfg.layout.smoothScroll ? 'smooth' : 'auto',
    });
  };

  const scrollToElement = (el) => {
    if (!el) {
      return;
    }
    const offset = (state.cfg.layout.scrollOffset / 100) * scroller.clientHeight;
    scrollToY(scroller.scrollTop + el.getBoundingClientRect().top - offset);
  };

  const stepBlock = (direction) => {
    const anchor = (state.cfg.layout.scrollOffset / 100) * window.innerHeight;
    const current = blockNearest(anchor);
    const index = state.blocks.indexOf(current);
    const next = state.blocks[clamp(index + direction, 0, state.blocks.length - 1)];
    state.manualIndex = clamp(index + direction, 0, state.blocks.length - 1);
    scrollToElement(next);
  };

  const stepHeading = (direction) => {
    const line = window.innerHeight * 0.25;
    const els = state.headings
      .map((h) => document.getElementById(h.slug))
      .filter(Boolean);
    if (direction > 0) {
      const next = els.find((el) => el.getBoundingClientRect().top > line + 4);
      scrollToElement(next ?? els[els.length - 1]);
    } else {
      const prev = [...els].reverse().find((el) => el.getBoundingClientRect().top < line - 4);
      scrollToElement(prev ?? els[0]);
    }
  };

  const tickAutoScroll = (now) => {
    if (!state.autoScroll) {
      return;
    }
    const dt = state.autoLast ? (now - state.autoLast) / 1000 : 0;
    state.autoLast = now;
    scroller.scrollTop += state.cfg.reading.autoScrollSpeed * dt;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) {
      stopAutoScroll();
      return;
    }
    state.autoRaf = requestAnimationFrame(tickAutoScroll);
  };

  const startAutoScroll = () => {
    state.autoScroll = true;
    state.autoLast = 0;
    // Auto-scroll and smooth scrolling fight each other; disable it while running.
    scroller.style.scrollBehavior = 'auto';
    state.autoRaf = requestAnimationFrame(tickAutoScroll);
    toast(`auto scroll ${state.cfg.reading.autoScrollSpeed} px/s`);
  };

  const stopAutoScroll = () => {
    state.autoScroll = false;
    cancelAnimationFrame(state.autoRaf);
    scroller.style.scrollBehavior = '';
    toast('auto scroll off');
  };

  const toggleAutoScroll = () => (state.autoScroll ? stopAutoScroll() : startAutoScroll());

  /* --------------------------------------------------------------- find bar */

  const clearFind = () => {
    for (const hit of doc.querySelectorAll('mark.find-hit')) {
      const parent = hit.parentNode;
      parent.replaceChild(document.createTextNode(hit.textContent), hit);
      parent.normalize();
    }
    state.findHits = [];
    state.findIndex = 0;
  };

  const runFind = (query) => {
    clearFind();
    if (query.length < 2) {
      $('find-count').textContent = '0/0';
      return;
    }
    const needle = query.toLowerCase();
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement && !node.parentElement.closest('script, style')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const targets = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue.toLowerCase().includes(needle)) {
        targets.push(node);
      }
    }
    for (const node of targets) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let from = 0;
      let at = text.toLowerCase().indexOf(needle);
      while (at !== -1) {
        frag.appendChild(document.createTextNode(text.slice(from, at)));
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = text.slice(at, at + query.length);
        frag.appendChild(mark);
        from = at + query.length;
        at = text.toLowerCase().indexOf(needle, from);
      }
      frag.appendChild(document.createTextNode(text.slice(from)));
      node.parentNode.replaceChild(frag, node);
    }
    state.findHits = Array.from(doc.querySelectorAll('mark.find-hit'));
    state.findIndex = 0;
    gotoHit(0);
  };

  const gotoHit = (index) => {
    if (state.findHits.length === 0) {
      $('find-count').textContent = '0/0';
      return;
    }
    state.findIndex = (index + state.findHits.length) % state.findHits.length;
    state.findHits.forEach((h, i) => h.classList.toggle('current', i === state.findIndex));
    scrollToElement(state.findHits[state.findIndex]);
    $('find-count').textContent = `${state.findIndex + 1}/${state.findHits.length}`;
  };

  const openFind = () => {
    $('find').hidden = false;
    const input = $('find-input');
    input.focus();
    input.select();
  };

  const closeFind = () => {
    $('find').hidden = true;
    clearFind();
    scroller.focus();
  };

  /* ------------------------------------------------------------------ help */

  const HELP = [
    ['Move', ''],
    ['j / k', 'Next / previous block'],
    ['Space / ⇧Space', 'Page down / up'],
    ['d / u', 'Half page down / up'],
    ['n / p', 'Next / previous heading'],
    ['g / G', 'Top / bottom'],
    ['a', 'Toggle auto scroll'],
    ['&lt; / &gt;', 'Auto scroll slower / faster'],
    ['Type', ''],
    ['+ / -', 'Font size'],
    ['0', 'Reset font size'],
    ['[ / ]', 'Narrower / wider line length'],
    ['{ / }', 'Tighter / looser line height'],
    ['y', 'Cycle font preset'],
    ['t', 'Cycle theme'],
    ['T', 'Theme picker'],
    ['Read', ''],
    ['f', 'Cycle focus mode'],
    ['b', 'Toggle bionic reading'],
    ['r', 'Cycle reading ruler'],
    ['w', 'Cycle code block display'],
    ['s', 'Toggle outline'],
    ['Do', ''],
    ['/', 'Find in document'],
    ['e', 'Edit source at this position'],
    [',', 'Open all settings'],
    ['? ', 'This help'],
    ['Esc', 'Close overlay'],
  ];

  const buildHelp = () => {
    const list = $('help-list');
    list.innerHTML = HELP.map(([key, desc]) =>
      desc === ''
        ? `<div class="help-sec">${key}</div>`
        : `<dt>${key}</dt><dd>${desc}</dd>`,
    ).join('');
  };

  const toggleHelp = () => {
    const help = $('help');
    help.hidden = !help.hidden;
  };

  /* ---------------------------------------------------------- theme picker */

  /* Must stay in the same order as `THEMES` in src/config.ts, because `t`
     cycles this list in the webview and the `lucid.cycleTheme` command cycles
     that one, and the two would disagree about what comes next. Light
     palettes first, then dark, so a cycle walks a family before it jumps. */
  const THEMES = [
    'auto',
    'paper',
    'sepia',
    'parchment',
    'dawn',
    'sage',
    'mist',
    'newsprint',
    'gray',
    'contrast',
    'dim',
    'dark',
    'midnight',
    'ocean',
    'forest',
    'ember',
    'plum',
    'black',
    'contrast-dark',
    'custom',
  ];

  /* Preview writes `body.dataset.theme` directly instead of going through
     setSetting, so that arrowing across 19 palettes does not write 19 times to
     settings.json. `themePicker.saved` holds the palette to restore on Esc. */
  const themePicker = { saved: null };

  const buildThemes = () => {
    const grid = $('themes-grid');
    if (!grid) {
      return;
    }
    grid.innerHTML = THEMES.map(
      (name) =>
        `<button class="sw" type="button" role="option" aria-selected="false" data-sw="${name}">` +
        `<span class="sw-name"><span class="sw-dot"></span>${name}</span>` +
        `<span class="sw-lines"><i></i><i></i><i></i></span>` +
        `</button>`,
    ).join('');
  };

  const previewTheme = (name) => {
    body.dataset.theme = name;
    for (const sw of $('themes-grid')?.children ?? []) {
      const on = sw.dataset.sw === name;
      sw.classList.toggle('current', on);
      sw.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  };

  const openThemes = () => {
    if (!state.cfg || !$('themes')) {
      return;
    }
    themePicker.saved = state.cfg.theme.name;
    $('themes').hidden = false;
    previewTheme(themePicker.saved);
    const current = $('themes-grid').querySelector('.sw.current') ?? $('themes-grid').firstElementChild;
    current?.focus();
  };

  /** `keep` commits the previewed palette; otherwise the entry palette returns. */
  const closeThemes = (keep) => {
    if ($('themes')?.hidden !== false) {
      return;
    }
    const shown = body.dataset.theme;
    $('themes').hidden = true;
    if (keep && shown !== themePicker.saved) {
      setSetting('theme.name', shown, `theme ${shown}`);
    } else {
      body.dataset.theme = themePicker.saved;
    }
    themePicker.saved = null;
    scroller.focus();
  };

  const stepThemeFocus = (step) => {
    const swatches = [...($('themes-grid')?.children ?? [])];
    if (swatches.length === 0) {
      return;
    }
    const at = swatches.findIndex((sw) => sw === document.activeElement);
    const next = swatches[(at < 0 ? 0 : at + step + swatches.length) % swatches.length];
    next.focus();
    previewTheme(next.dataset.sw);
  };

  /* -------------------------------------------------------------- keyboard */

  const FONTS = ['serif', 'sans', 'humanist', 'hyperlegible', 'dyslexic', 'mono', 'editor', 'custom'];
  const FOCUS = ['off', 'paragraph', 'sentence', 'line'];
  const RULERS = ['off', 'band', 'underline', 'spotlight'];
  const CODE = ['expanded', 'collapsed', 'hidden'];

  const onKeyDown = (event) => {
    if (event.target.tagName === 'INPUT') {
      return;
    }
    // While the theme picker is open it owns the keyboard. Its own handler on
    // #themes runs first for keys pressed with a swatch focused, but keydown
    // still bubbles to this listener, and without the guard an arrow key would
    // both move the selection and scroll the document behind the overlay.
    // Escape stays here as well, for the case where a backdrop click moved
    // focus out of the grid.
    if ($('themes')?.hidden === false) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeThemes(false);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault();
        openFind();
      }
      return;
    }

    const t = state.cfg.typography;
    const r = state.cfg.reading;
    const page = scroller.clientHeight * 0.9;
    let handled = true;

    switch (event.key) {
      case 'j': stepBlock(1); break;
      case 'k': stepBlock(-1); break;
      case 'ArrowDown': scrollToY(scroller.scrollTop + 90, false); break;
      case 'ArrowUp': scrollToY(scroller.scrollTop - 90, false); break;
      case ' ':
        scrollToY(scroller.scrollTop + (event.shiftKey ? -page : page));
        break;
      case 'd': scrollToY(scroller.scrollTop + page / 2); break;
      case 'u': scrollToY(scroller.scrollTop - page / 2); break;
      case 'n': stepHeading(1); break;
      case 'p': stepHeading(-1); break;
      case 'g': scrollToY(0); break;
      case 'G': scrollToY(scroller.scrollHeight); break;
      case 'Home': scrollToY(0); break;
      case 'End': scrollToY(scroller.scrollHeight); break;

      case '+':
      case '=':
        setSetting('typography.fontSize', clamp(t.fontSize + 1, 10, 48), `${t.fontSize + 1}px`);
        break;
      case '-':
      case '_':
        setSetting('typography.fontSize', clamp(t.fontSize - 1, 10, 48), `${t.fontSize - 1}px`);
        break;
      case '0':
        setSetting('typography.fontSize', 19, '19px');
        break;
      case ']':
        setSetting('typography.measure', clamp(t.measure + 2, 30, 140), `${t.measure + 2}ch`);
        break;
      case '[':
        setSetting('typography.measure', clamp(t.measure - 2, 30, 140), `${t.measure - 2}ch`);
        break;
      case '}':
        setSetting(
          'typography.lineHeight',
          Math.round(clamp(t.lineHeight + 0.05, 1, 3) * 100) / 100,
          `line height ${Math.round(clamp(t.lineHeight + 0.05, 1, 3) * 100) / 100}`,
        );
        break;
      case '{':
        setSetting(
          'typography.lineHeight',
          Math.round(clamp(t.lineHeight - 0.05, 1, 3) * 100) / 100,
          `line height ${Math.round(clamp(t.lineHeight - 0.05, 1, 3) * 100) / 100}`,
        );
        break;

      case 't': {
        const next = cycleValue(THEMES, state.cfg.theme.name);
        setSetting('theme.name', next, `theme ${next}`);
        break;
      }
      case 'T': openThemes(); break;
      case 'y': {
        const next = cycleValue(FONTS, t.fontPreset);
        setSetting('typography.fontPreset', next, `font ${next}`);
        break;
      }
      case 'f': {
        const next = cycleValue(FOCUS, r.focusMode);
        setSetting('reading.focusMode', next, `focus ${next}`);
        break;
      }
      case 'b':
        setSetting('reading.bionic', !r.bionic, `bionic ${!r.bionic ? 'on' : 'off'}`);
        break;
      case 'r': {
        const next = cycleValue(RULERS, r.ruler);
        setSetting('reading.ruler', next, `ruler ${next}`);
        break;
      }
      case 'w': {
        const next = cycleValue(CODE, state.cfg.layout.codeBlocks);
        setSetting('layout.codeBlocks', next, `code ${next}`);
        break;
      }
      case 's': {
        const next = state.cfg.layout.toc === 'never' ? 'always' : 'never';
        setSetting('layout.toc', next, `outline ${next === 'never' ? 'hidden' : 'shown'}`);
        break;
      }
      case 'a': toggleAutoScroll(); break;
      case '>':
      case '.':
        setSetting(
          'reading.autoScrollSpeed',
          clamp(Math.round(r.autoScrollSpeed * 1.25), 4, 400),
          `${clamp(Math.round(r.autoScrollSpeed * 1.25), 4, 400)} px/s`,
        );
        break;
      case '<':
      case ',':
        if (event.key === ',' && !event.shiftKey) {
          vscode.postMessage({ type: 'settings' });
          break;
        }
        setSetting(
          'reading.autoScrollSpeed',
          clamp(Math.round(r.autoScrollSpeed / 1.25), 4, 400),
          `${clamp(Math.round(r.autoScrollSpeed / 1.25), 4, 400)} px/s`,
        );
        break;

      case '/': openFind(); break;
      case 'e': editHere(); break;
      case '?': toggleHelp(); break;
      case 'Escape':
        if (!$('help').hidden) {
          toggleHelp();
        } else if (!$('find').hidden) {
          closeFind();
        } else if (state.autoScroll) {
          stopAutoScroll();
        }
        break;
      default:
        handled = false;
    }

    if (handled) {
      event.preventDefault();
    }
  };

  const editHere = () => {
    const anchor = (state.cfg.layout.scrollOffset / 100) * window.innerHeight;
    let el = blockNearest(anchor);
    while (el && !el.dataset.line) {
      el = el.parentElement;
    }
    vscode.postMessage({ type: 'edit', line: el ? Number(el.dataset.line) : 0 });
  };

  /* ---------------------------------------------------------------- events */

  let scrollTick = 0;
  let saveTimer = 0;

  scroller.addEventListener(
    'scroll',
    () => {
      if (scrollTick) {
        return;
      }
      scrollTick = requestAnimationFrame(() => {
        scrollTick = 0;
        updateChrome();
        updateFocus();
      });
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        vscode.postMessage({ type: 'position', ratio: scrollRatio() });
      }, 400);
    },
    { passive: true },
  );

  window.addEventListener('resize', () => {
    layoutToc();
    updateChrome();
    updateFocus();
  });

  document.addEventListener(
    'mousemove',
    (event) => {
      state.pointer.x = event.clientX;
      state.pointer.y = event.clientY;
      state.pointer.active = true;
      body.classList.remove('hide-cursor');
      if (state.cfg?.reading.hideCursorWhenIdle) {
        clearTimeout(state.cursorTimer);
        state.cursorTimer = setTimeout(() => body.classList.add('hide-cursor'), 2000);
      }
      if (state.cfg?.reading.focusFollows === 'mouse' || state.cfg?.reading.ruler !== 'off') {
        updateFocus();
      }
    },
    { passive: true },
  );

  document.addEventListener('keydown', onKeyDown);

  wireTocResize();

  /**
   * One delegated click handler for the whole article. The order of the
   * branches below is load-bearing, not stylistic: the caption buttons sit
   * *inside* `figure.code`, so in `codeBlocks: 'collapsed'` mode a Copy or
   * Wrap click also matches the collapse branch. Each button branch must run
   * first and return, or pressing Copy would fold the block you just copied.
   * Any new control added inside a figure needs the same treatment.
   */
  doc.addEventListener('click', (event) => {
    const copy = event.target.closest('.code-copy');
    if (copy) {
      event.preventDefault();
      const code = copy.closest('figure.code')?.querySelector('code')?.textContent ?? '';
      vscode.postMessage({ type: 'copy', text: code });
      toast('copied');
      return;
    }

    if (event.target.closest('.code-wrap')) {
      event.preventDefault();
      const on = !!state.cfg?.layout.wrapCode;
      setSetting('layout.wrapCode', !on, on ? 'code wrap off' : 'code wrap on');
      return;
    }

    const figure = event.target.closest('figure.code');
    if (figure && state.cfg.layout.codeBlocks === 'collapsed') {
      figure.classList.toggle('open');
      return;
    }

    const img = event.target.closest('img');
    if (img) {
      img.classList.toggle('zoomed');
      return;
    }

    const link = event.target.closest('a');
    if (!link) {
      return;
    }
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      const target = document.getElementById(decodeURIComponent(href.slice(1)));
      if (target) {
        scrollToElement(target);
        history.replaceState(null, '', href);
      }
      return;
    }
    vscode.postMessage({ type: 'link', href });
  });

  on('toc-list', 'click', (event) => {
    const link = event.target.closest('a');
    if (!link) {
      return;
    }
    event.preventDefault();
    scrollToElement(document.getElementById(link.dataset.slug));
  });

  on('find-input', 'input', (event) => runFind(event.target.value));
  on('find-input', 'keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      gotoHit(state.findIndex + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
  on('find-next', 'click', () => gotoHit(state.findIndex + 1));
  on('find-prev', 'click', () => gotoHit(state.findIndex - 1));
  on('find-close', 'click', closeFind);
  on('themes-grid', 'click', (event) => {
    const sw = event.target.closest('.sw');
    if (sw) {
      previewTheme(sw.dataset.sw);
      closeThemes(true);
    }
  });

  /* The picker keeps focus inside itself, so its keys are handled here rather
     than in onKeyDown, which returns early for anything but the scroller. */
  on('themes', 'keydown', (event) => {
    const columns = Math.max(
      1,
      Math.round($('themes-grid').clientWidth / ($('themes-grid').firstElementChild?.offsetWidth || 1)),
    );
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    if (step) {
      event.preventDefault();
      stepThemeFocus(step);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      closeThemes(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeThemes(false);
    }
  });

  on('themes', 'click', (event) => {
    if (event.target.id === 'themes') {
      closeThemes(false);
    }
  });

  on('hud-help', 'click', toggleHelp);
  on('help-close', 'click', toggleHelp);
  on('help', 'click', (event) => {
    if (event.target.id === 'help') {
      toggleHelp();
    }
  });

  /* --------------------------------------------------------------- messages */

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'render':
        setDocument(msg);
        break;
      case 'config':
        applyConfig(msg.config);
        buildToc();
        break;
      case 'patch':
        setPath(state.cfg, msg.key, msg.value);
        applyConfig(state.cfg);
        break;
      case 'action':
        if (msg.action === 'find') {
          openFind();
        } else if (msg.action === 'themes') {
          openThemes();
        } else if (msg.action === 'autoscroll') {
          toggleAutoScroll();
        } else if (msg.action === 'edit') {
          editHere();
        }
        break;
      default:
        break;
    }
  });

  /* `ready` is the handshake that makes the extension send the document, so it
     has to survive a failure in anything above it. Chrome that never got built
     is a missing overlay; a document that never arrives is a blank window. */
  try {
    buildHelp();
    buildThemes();
    scroller.focus();
  } catch (error) {
    console.error('Lucid: reader chrome failed to initialise', error);
  }
  vscode.postMessage({ type: 'ready' });
})();
