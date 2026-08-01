/**
 * Markdown -> HTML, written from scratch so we own the output shape.
 *
 * WHY NOT markdown-it: the reader needs structural hooks a generic renderer
 * doesn't emit - `data-line` on every top-level block (scroll sync + "edit
 * here"), `data-words` for progress, callout blocks, and a heading index built
 * during the same pass. Owning the parser is cheaper than post-processing
 * somebody else's DOM, and it keeps the runtime dependency count at zero.
 *
 * SAFETY MODEL: everything is HTML-escaped first, then a small allowlist of
 * inert tags is un-escaped (see ALLOWED_TAGS). Attributes are never restored,
 * so no `onerror=`, no `<script>`, no `javascript:` hrefs survive. This is a
 * deliberate trade: `<div align=center>` in a README renders as literal text.
 */

export type Heading = { level: number; text: string; slug: string; line: number };

export type Rendered = {
  html: string;
  headings: Heading[];
  words: number;
  frontMatter: Array<[string, string]> | null;
};

export type MarkdownOptions = {
  smartQuotes: boolean;
  smartDashes: boolean;
  allowRawHtmlTags: boolean;
};

export const defaultMarkdownOptions: MarkdownOptions = {
  smartQuotes: true,
  smartDashes: false,
  allowRawHtmlTags: true,
};

/* ------------------------------------------------------------------ utils */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);

/** Inert tags a reader can safely honour. Attributes are stripped regardless. */
const ALLOWED_TAGS =
  'br|kbd|sub|sup|mark|ins|del|abbr|small|u|s|details|summary|dl|dt|dd|wbr';

const restoreAllowedTags = (s: string): string =>
  s.replace(
    new RegExp(`&lt;(/?)(${ALLOWED_TAGS})(?:\\s[^&]*?)?/?&gt;`, 'gi'),
    (_m, slash: string, tag: string) => `<${slash}${tag.toLowerCase()}>`,
  );

const slugify = (text: string, seen: Map<string, number>): string => {
  const base =
    text
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section';
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
};

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const countWords = (text: string): number => (text.match(WORD_RE) ?? []).length;

/* ------------------------------------------------------------- front matter */

const parseFrontMatter = (src: string): { pairs: Array<[string, string]>; consumed: number } | null => {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) {
    return null;
  }
  const pairs: Array<[string, string]> = [];
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (kv) {
      pairs.push([kv[1], kv[2].replace(/^["']|["']$/g, '').trim()]);
    }
  }
  return { pairs, consumed: (m[0].match(/\n/g) ?? []).length };
};

/* -------------------------------------------------------------- inline pass */

type Ctx = {
  defs: Map<string, { url: string; title: string }>;
  footnotes: Map<string, { index: number; html: string }>;
  headings: Heading[];
  slugs: Map<string, number>;
  opts: MarkdownOptions;
};

const attr = (s: string): string => s.replace(/"/g, '&quot;');

/** Block `javascript:`-style hrefs before they ever reach the DOM. */
const safeUrl = (url: string): string => {
  const trimmed = url.trim().replace(/^<|>$/g, '');
  if (/^\s*(javascript|vbscript):/i.test(trimmed)) {
    return '#';
  }
  return trimmed;
};

const inline = (src: string, ctx: Ctx): string => {
  const stash: string[] = [];
  const put = (html: string): string => `\u0000${stash.push(html) - 1}\u0000`;

  let s = src;

  // 1. Backslash escapes and code spans are stashed *before* HTML-escaping so
  //    their contents are never re-interpreted as markdown.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~|"'=])/g, (_m, c: string) => put(escapeHtml(c)));

  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) =>
    put(`<code class="inline">${escapeHtml(code.replace(/^ (.*) $/s, '$1'))}</code>`),
  );

  // 2. Autolinks, before escaping eats the angle brackets.
  s = s.replace(/<((?:https?|mailto):[^\s<>]+)>/g, (_m, url: string) => {
    const safe = safeUrl(url);
    return put(`<a href="${attr(escapeHtml(safe))}" class="autolink">${escapeHtml(safe)}</a>`);
  });

  s = escapeHtml(s);

  if (ctx.opts.allowRawHtmlTags) {
    s = restoreAllowedTags(s);
  }

  // 3. Hard line breaks.
  s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n');

  // 4. Images (fully stashed - alt text is plain).
  //    NOTE: titles are matched against `&quot;` as well as raw quotes, because
  //    this runs *after* escapeHtml. Forgetting that silently drops any link
  //    or image that carries a "title".
  s = s.replace(
    /!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+(?:&quot;|['(])(.*?)(?:&quot;|['")]))?\s*\)/g,
    (_m, alt: string, url: string, title?: string) =>
      put(
        `<img src="${attr(safeUrl(url))}" alt="${attr(alt)}"${
          title ? ` title="${attr(title)}"` : ''
        } loading="lazy">`,
      ),
  );

  // 5. Wiki links: [[Target]] / [[Target|Label]].
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
    const href = /\.\w+$/.test(target.trim()) ? target.trim() : `${target.trim()}.md`;
    return `${put(`<a href="${attr(href)}" class="wikilink">`)}${label ?? target}${put('</a>')}`;
  });

  // 6. Footnote references.
  s = s.replace(/\[\^([^\]]+)\]/g, (m, id: string) => {
    const fn = ctx.footnotes.get(id);
    if (!fn) {
      return m;
    }
    return put(
      `<sup class="fnref" id="fnref-${attr(id)}"><a href="#fn-${attr(id)}">${fn.index}</a></sup>`,
    );
  });

  // 7. Inline links. The open/close tags are stashed so emphasis parsing can't
  //    corrupt a URL containing `*` or `_`, while the link *text* stays in the
  //    stream and keeps getting formatted.
  s = s.replace(
    /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*([^\s)]*)(?:\s+(?:&quot;|['(])(.*?)(?:&quot;|['")]))?\s*\)/g,
    (_m, text: string, url: string, title?: string) =>
      `${put(
        `<a href="${attr(safeUrl(url))}"${title ? ` title="${attr(title)}"` : ''}>`,
      )}${text}${put('</a>')}`,
  );

  // 8. Reference links: [text][ref] and shortcut [ref].
  s = s.replace(/\[((?:[^[\]]|\[[^\]]*\])*)\]\[([^\]]*)\]/g, (m, text: string, ref: string) => {
    const def = ctx.defs.get((ref || text).toLowerCase());
    if (!def) {
      return m;
    }
    return `${put(
      `<a href="${attr(safeUrl(def.url))}"${def.title ? ` title="${attr(def.title)}"` : ''}>`,
    )}${text}${put('</a>')}`;
  });
  s = s.replace(/\[([^[\]]+)\]/g, (m, text: string) => {
    const def = ctx.defs.get(text.toLowerCase());
    if (!def) {
      return m;
    }
    return `${put(
      `<a href="${attr(safeUrl(def.url))}"${def.title ? ` title="${attr(def.title)}"` : ''}>`,
    )}${text}${put('</a>')}`;
  });

  // 9. Emphasis. Longest delimiter first, `_` restricted to word boundaries so
  //    snake_case_identifiers survive intact.
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(["'])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}])/gu, '$1<strong>$2</strong>');
  s = s.replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[\s(["'])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}])/gu, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');

  // 10. Typographic polish. Safe here because code spans are already stashed.
  if (ctx.opts.smartQuotes) {
    s = s
      .replace(/\.\.\./g, '…')
      .replace(/(^|[\s([{<])"/g, '$1“')
      .replace(/"/g, '”')
      .replace(/(^|[\s([{<])'/g, '$1‘')
      .replace(/'/g, '’');
  }
  if (ctx.opts.smartDashes) {
    s = s.replace(/---/g, '—').replace(/(\s)--(\s)/g, '$1–$2');
  }

  // 11. Restore stashed fragments (loop: a stashed tag may embed a placeholder).
  for (let pass = 0; pass < 6 && s.includes('\u0000'); pass += 1) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => stash[Number(n)] ?? '');
  }

  return s;
};

/* --------------------------------------------------------------- block pass */

type Block = { html: string; inner: string | null };

const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RE_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(\S*)[ \t]*(.*)$/;
const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_BQ = /^ {0,3}>[ \t]?/;
const RE_UL = /^( {0,7})([-*+])([ \t]+)(.*)$/;
const RE_OL = /^( {0,7})(\d{1,9})([.)])([ \t]+)(.*)$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const RE_LINKDEF = /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*(\S+)(?:[ \t]+["'(](.*)["')])?[ \t]*$/;
const RE_FOOTDEF = /^ {0,3}\[\^([^\]]+)\]:[ \t]*(.*)$/;
const RE_CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|DANGER|QUESTION|EXAMPLE|QUOTE)\]([-+]?)[ \t]*(.*)$/i;

const isBlank = (line: string): boolean => /^[ \t]*$/.test(line);

const startsBlock = (line: string): boolean =>
  RE_ATX.test(line) ||
  RE_FENCE.test(line) ||
  RE_HR.test(line) ||
  RE_BQ.test(line) ||
  RE_UL.test(line) ||
  RE_OL.test(line);

const dataLine = (n: number): string => ` data-line="${n}"`;

/**
 * Header shared by fenced and indented code blocks. `label` must already be
 * escaped. The wrap button carries no state here: the webview owns per-block
 * wrap, because the default comes from `lucid.layout.wrapCode` at read time.
 */
const codeCaption = (label: string): string =>
  `<figcaption><span class="code-lang">${label}</span>` +
  `<span class="code-actions">` +
  `<button class="code-wrap" type="button" title="Wrap long lines" aria-pressed="false">Wrap</button>` +
  `<button class="code-copy" type="button" title="Copy">Copy</button>` +
  `</span></figcaption>`;

const splitRow = (row: string): string[] => {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i];
    if (c === '\\' && trimmed[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
};

const renderBlocks = (lines: string[], ctx: Ctx, offset: number): Block[] => {
  const out: Block[] = [];
  let i = 0;

  const push = (html: string, inner: string | null = null): void => {
    out.push({ html, inner });
  };

  while (i < lines.length) {
    const line = lines[i];
    const abs = offset + i;

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Link / footnote definitions were harvested in the pre-pass; skip them.
    if (RE_LINKDEF.test(line) || RE_FOOTDEF.test(line)) {
      i += 1;
      if (RE_FOOTDEF.test(line)) {
        while (i < lines.length && (isBlank(lines[i]) === false) && /^(?: {2,}|\t)/.test(lines[i])) {
          i += 1;
        }
      }
      continue;
    }

    // Fenced code.
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const len = fence[2].length;
      const lang = fence[3];
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const close = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${len},}[ \\t]*$`);
        if (close.test(lines[i])) {
          i += 1;
          break;
        }
        body.push(lines[i].replace(new RegExp(`^ {0,${fence[1].length}}`), ''));
        i += 1;
      }
      const label = lang ? escapeHtml(lang) : 'text';
      push(
        `<figure class="code" data-lang="${attr(label)}"${dataLine(abs)}>` +
          codeCaption(label) +
          `<pre><code class="language-${attr(label)}">${escapeHtml(body.join('\n'))}\n</code></pre>` +
          `</figure>`,
      );
      continue;
    }

    // ATX heading.
    const atx = RE_ATX.exec(line);
    if (atx) {
      const level = atx[1].length;
      const html = inline(atx[2] ?? '', ctx);
      const text = stripTags(html);
      const slug = slugify(text, ctx.slugs);
      ctx.headings.push({ level, text, slug, line: abs });
      push(
        `<h${level} id="${attr(slug)}" class="h"${dataLine(abs)}>` +
          `<a class="anchor" href="#${attr(slug)}" aria-hidden="true">#</a>${html}</h${level}>`,
      );
      i += 1;
      continue;
    }

    // Thematic break. Checked before lists so `---` and `* * *` win.
    if (RE_HR.test(line)) {
      push(`<hr${dataLine(abs)}>`);
      i += 1;
      continue;
    }

    // Blockquote (and GitHub-style callouts).
    if (RE_BQ.test(line)) {
      const body: string[] = [];
      const start = i;
      while (i < lines.length) {
        if (RE_BQ.test(lines[i])) {
          body.push(lines[i].replace(RE_BQ, ''));
          i += 1;
        } else if (!isBlank(lines[i]) && !startsBlock(lines[i]) && body.length > 0) {
          body.push(lines[i]); // lazy continuation
          i += 1;
        } else {
          break;
        }
      }
      const callout = RE_CALLOUT.exec(body[0] ?? '');
      if (callout) {
        const kind = callout[1].toLowerCase();
        const title = callout[3].trim() || callout[1][0] + callout[1].slice(1).toLowerCase();
        body[0] = '';
        const innerHtml = renderBlocks(body, ctx, offset + start)
          .map((b) => b.html)
          .join('\n');
        push(
          `<div class="callout callout-${kind}"${dataLine(abs)}>` +
            `<p class="callout-title"><span class="callout-icon" aria-hidden="true"></span>${escapeHtml(
              title,
            )}</p>${innerHtml}</div>`,
        );
      } else {
        const innerHtml = renderBlocks(body, ctx, offset + start)
          .map((b) => b.html)
          .join('\n');
        push(`<blockquote${dataLine(abs)}>${innerHtml}</blockquote>`);
      }
      continue;
    }

    // Table.
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const cell = (tag: string, content: string, idx: number): string =>
        `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(
          content,
          ctx,
        )}</${tag}>`;
      push(
        `<div class="table-wrap"${dataLine(abs)}><table>` +
          `<thead><tr>${header.map((c, n) => cell('th', c, n)).join('')}</tr></thead>` +
          `<tbody>${rows
            .map((r) => `<tr>${header.map((_h, n) => cell('td', r[n] ?? '', n)).join('')}</tr>`)
            .join('')}</tbody></table></div>`,
      );
      continue;
    }

    // Lists.
    const ul = RE_UL.exec(line);
    const ol = RE_OL.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const startNum = ol ? Number(ol[2]) : 1;
      const items: Array<{ lines: string[]; line: number }> = [];
      let loose = false;

      // LOOSENESS CONTRACT (the fiddly part of this function).
      // `loose` decides whether items render as `<li><p>x</p></li>` or
      // `<li>x</li>`, and it can be set from two different scopes:
      //   1. inner loop - a blank line *inside* an item that is followed by
      //      more indented content (a multi-paragraph item);
      //   2. outer post-item check - a blank line that ends an item and is
      //      followed by another item of the same list.
      // A blank line followed by anything else is neither: it just ends the
      // list. Setting `loose` in the inner loop for case 3 was the original
      // bug, and it made every list that had a trailing blank line render
      // loose. `pendingBlank` is deliberately declared in the outer scope so
      // the post-item check can still see what the inner loop consumed.
      while (i < lines.length) {
        // A missing match means a different marker family, which starts a new
        // list rather than continuing this one.
        const m = ordered ? RE_OL.exec(lines[i]) : RE_UL.exec(lines[i]);
        if (!m) {
          break;
        }
        if (isBlank(lines[i])) {
          break;
        }
        const indent = m[1].length;
        const markerLen = ordered ? m[2].length + 1 : 1;
        const contentIndent = indent + markerLen + m[ordered ? 4 : 3].length;
        const itemLines = [m[ordered ? 5 : 4]];
        const itemStart = offset + i;
        i += 1;
        let pendingBlank = 0;
        while (i < lines.length) {
          const cur = lines[i];
          if (isBlank(cur)) {
            pendingBlank += 1;
            i += 1;
            if (pendingBlank > 1) {
              break;
            }
            continue;
          }
          const curIndent = cur.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length;
          const isNewItem = ordered ? RE_OL.test(cur) : RE_UL.test(cur);
          if (curIndent >= contentIndent) {
            if (pendingBlank > 0) {
              itemLines.push('');
              loose = true;
              pendingBlank = 0;
            }
            itemLines.push(cur.slice(Math.min(contentIndent, curIndent)));
            i += 1;
            continue;
          }
          // A blank line ends this item. Whether it also makes the *list* loose
          // depends on what follows, which only the post-item check below can
          // see - a blank line before an unrelated block is not looseness.
          if (pendingBlank > 0) {
            break;
          }
          if (isNewItem || startsBlock(cur)) {
            break;
          }
          itemLines.push(cur); // lazy paragraph continuation
          i += 1;
        }
        items.push({ lines: itemLines, line: itemStart });
        if (pendingBlank > 0 && i < lines.length) {
          const next = lines[i];
          const nextIsItem = ordered ? RE_OL.test(next) : RE_UL.test(next);
          if (nextIsItem) {
            loose = true;
          } else {
            break;
          }
        }
      }

      const renderedItems = items.map((item) => {
        const blocks = renderBlocks(item.lines, ctx, item.line);
        const body = loose
          ? blocks.map((b) => b.html).join('\n')
          : blocks.map((b) => b.inner ?? b.html).join('\n');
        const task = /^\[([ xX])\]\s+/.exec(item.lines[0] ?? '');
        if (task) {
          const checked = task[1].toLowerCase() === 'x';
          const stripped = body.replace(/\[([ xX])\]\s+/, '');
          return (
            `<li class="task ${checked ? 'done' : 'todo'}"${dataLine(item.line)}>` +
            `<span class="checkbox" aria-hidden="true">${checked ? '✓' : ''}</span>` +
            `<span class="task-body">${stripped}</span></li>`
          );
        }
        return `<li${dataLine(item.line)}>${body}</li>`;
      });

      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
      push(
        `<${tag} class="${loose ? 'loose' : 'tight'}"${startAttr}${dataLine(abs)}>${renderedItems.join(
          '',
        )}</${tag}>`,
      );
      continue;
    }

    // Indented code block (only when it can't be list continuation).
    if (/^(?: {4}|\t)/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || isBlank(lines[i]))) {
        if (isBlank(lines[i]) && !lines.slice(i + 1).some((l) => /^(?: {4}|\t)/.test(l))) {
          break;
        }
        body.push(lines[i].replace(/^(?: {4}|\t)/, ''));
        i += 1;
      }
      push(
        `<figure class="code" data-lang="text"${dataLine(abs)}>` +
          codeCaption('text') +
          `<pre><code>${escapeHtml(body.join('\n'))}\n</code></pre></figure>`,
      );
      continue;
    }

    // Paragraph / setext heading.
    const para: string[] = [];
    const paraStart = abs;
    while (i < lines.length && !isBlank(lines[i])) {
      if (para.length > 0 && RE_SETEXT.test(lines[i])) {
        const level = lines[i].trim().startsWith('=') ? 1 : 2;
        const html = inline(para.join('\n'), ctx);
        const text = stripTags(html);
        const slug = slugify(text, ctx.slugs);
        ctx.headings.push({ level, text, slug, line: paraStart });
        push(
          `<h${level} id="${attr(slug)}" class="h"${dataLine(paraStart)}>` +
            `<a class="anchor" href="#${attr(slug)}" aria-hidden="true">#</a>${html}</h${level}>`,
        );
        i += 1;
        para.length = 0;
        break;
      }
      if (para.length > 0 && startsBlock(lines[i])) {
        break;
      }
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) {
      const html = inline(para.join('\n'), ctx);
      push(`<p${dataLine(paraStart)}>${html}</p>`, html);
    }
  }

  return out;
};

/* ------------------------------------------------------------------- render */

export const render = (source: string, options: MarkdownOptions): Rendered => {
  const normalized = source.replace(/\r\n?/g, '\n');
  const fm = parseFrontMatter(normalized);
  const body = fm ? normalized.split('\n').slice(fm.consumed + 1).join('\n') : normalized;
  const lineOffset = fm ? fm.consumed + 1 : 0;
  const lines = body.split('\n');

  const ctx: Ctx = {
    defs: new Map(),
    footnotes: new Map(),
    headings: [],
    slugs: new Map(),
    opts: options,
  };

  // Pre-pass: link definitions and footnote bodies must be known before the
  // main pass, because references can appear above their definitions.
  const footRaw = new Map<string, string[]>();
  let currentFoot: string | null = null;
  for (const line of lines) {
    const def = RE_LINKDEF.exec(line);
    if (def) {
      ctx.defs.set(def[1].toLowerCase(), { url: def[2], title: def[3] ?? '' });
      currentFoot = null;
      continue;
    }
    const foot = RE_FOOTDEF.exec(line);
    if (foot) {
      currentFoot = foot[1];
      footRaw.set(currentFoot, [foot[2]]);
      continue;
    }
    if (currentFoot && /^(?: {2,}|\t)\S/.test(line)) {
      footRaw.get(currentFoot)!.push(line.trim());
      continue;
    }
    if (currentFoot && isBlank(line)) {
      continue;
    }
    currentFoot = null;
  }
  let fnIndex = 0;
  for (const id of footRaw.keys()) {
    fnIndex += 1;
    ctx.footnotes.set(id, { index: fnIndex, html: '' });
  }
  for (const [id, raw] of footRaw) {
    const entry = ctx.footnotes.get(id)!;
    entry.html = inline(raw.join(' ').trim(), ctx);
  }

  const blocks = renderBlocks(lines, ctx, lineOffset);
  let html = blocks.map((b) => b.html).join('\n');

  if (ctx.footnotes.size > 0) {
    const items = [...ctx.footnotes.entries()]
      .map(
        ([id, fn]) =>
          `<li id="fn-${attr(id)}"><span class="fn-num">${fn.index}</span>` +
          `<span class="fn-body">${fn.html} ` +
          `<a class="fn-back" href="#fnref-${attr(id)}" title="Back to text">↩</a></span></li>`,
      )
      .join('');
    html += `\n<section class="footnotes"><h2 class="footnotes-title">Notes</h2><ol>${items}</ol></section>`;
  }

  // Word count excludes fenced code so the reading estimate reflects prose.
  const prose = body
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`]*`/g, '');

  return {
    html,
    headings: ctx.headings,
    words: countWords(prose),
    frontMatter: fm && fm.pairs.length > 0 ? fm.pairs : null,
  };
};
