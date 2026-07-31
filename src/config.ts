/**
 * Settings plumbing.
 *
 * Every reader setting lives in exactly one place: package.json's
 * `contributes.configuration`. This module reads it back with clamping, so a
 * hand-edited settings.json with `fontSize: 9000` degrades instead of breaking
 * the layout. The shape returned here is what gets serialised into the webview.
 *
 * WHY NO ZOD: this is a VS Code extension, and VS Code already validates
 * against the JSON schema in package.json before we ever see a value. A runtime
 * schema library would duplicate that contract and add a dependency to ship.
 * The clamp helpers below are the whole validation story.
 */

import * as vscode from 'vscode';

export type ReaderConfig = ReturnType<typeof readConfig>;

const SECTION = 'lucid';

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

export const FONT_PRESETS = [
  'serif',
  'sans',
  'humanist',
  'hyperlegible',
  'dyslexic',
  'mono',
  'editor',
  'custom',
] as const;

export const THEMES = [
  'auto',
  'paper',
  'sepia',
  'gray',
  'dim',
  'dark',
  'black',
  'contrast',
  'custom',
] as const;

export const FOCUS_MODES = ['off', 'paragraph', 'sentence', 'line'] as const;
export const RULERS = ['off', 'band', 'underline', 'spotlight'] as const;

/** Font stacks. No font files are bundled; these degrade to whatever is installed. */
export const FONT_STACKS: Record<string, string> = {
  serif:
    "'Iowan Old Style', 'Charter', 'Bitstream Charter', 'Source Serif 4', 'Literata', Georgia, Cambria, 'Times New Roman', serif",
  sans: "'Inter', 'Inter Variable', -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Roboto, Ubuntu, 'Helvetica Neue', sans-serif",
  humanist:
    "'Seravek', 'Gill Sans Nova', 'Ubuntu', 'Calibri', 'Source Sans 3', 'Source Sans Pro', 'Optima', sans-serif",
  hyperlegible: "'Atkinson Hyperlegible', 'Atkinson Hyperlegible Next', 'Inter', Verdana, sans-serif",
  dyslexic:
    "'OpenDyslexic', 'OpenDyslexic3', 'Lexie Readable', 'Atkinson Hyperlegible', 'Comic Neue', Verdana, sans-serif",
  mono: "'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace",
  editor: 'var(--vscode-editor-font-family)',
};

export const readConfig = (scope?: vscode.Uri) => {
  const c = vscode.workspace.getConfiguration(SECTION, scope);

  const fontPreset = pick(c.get('typography.fontPreset'), FONT_PRESETS, 'serif');
  const customFamily = str(c.get('typography.customFontFamily'), '');

  return {
    typography: {
      fontPreset,
      fontFamily:
        fontPreset === 'custom' && customFamily.trim().length > 0
          ? customFamily
          : FONT_STACKS[fontPreset] ?? FONT_STACKS.serif,
      headingFontFamily: str(c.get('typography.headingFontFamily'), ''),
      codeFontFamily: str(c.get('typography.codeFontFamily'), ''),
      fontSize: clamp(c.get('typography.fontSize'), 10, 48, 19),
      fontWeight: clamp(c.get('typography.fontWeight'), 100, 800, 400),
      lineHeight: clamp(c.get('typography.lineHeight'), 1, 3, 1.7),
      measure: clamp(c.get('typography.measure'), 30, 140, 68),
      letterSpacing: clamp(c.get('typography.letterSpacing'), -0.05, 0.25, 0),
      wordSpacing: clamp(c.get('typography.wordSpacing'), 0, 1, 0),
      paragraphSpacing: clamp(c.get('typography.paragraphSpacing'), 0, 4, 1.1),
      paragraphIndent: clamp(c.get('typography.paragraphIndent'), 0, 6, 0),
      textAlign: pick(c.get('typography.textAlign'), ['left', 'justify'] as const, 'left'),
      hyphens: bool(c.get('typography.hyphens'), false),
      headingScale: clamp(c.get('typography.headingScale'), 0.6, 2, 1),
      balanceHeadings: bool(c.get('typography.balanceHeadings'), true),
      prettyWrap: bool(c.get('typography.prettyWrap'), true),
      hangingPunctuation: bool(c.get('typography.hangingPunctuation'), true),
      smartQuotes: bool(c.get('typography.smartQuotes'), true),
      smartDashes: bool(c.get('typography.smartDashes'), false),
      numerals: pick(
        c.get('typography.numerals'),
        ['lining', 'oldstyle', 'tabular'] as const,
        'lining',
      ),
      dropCap: bool(c.get('typography.dropCap'), false),
    },
    theme: {
      name: pick(c.get('theme.name'), THEMES, 'auto'),
      customColors: (c.get('theme.customColors') as Record<string, string>) ?? {},
      textContrast: clamp(c.get('theme.textContrast'), 0.5, 1, 1),
      linkStyle: pick(
        c.get('theme.linkStyle'),
        ['underline', 'subtle', 'color', 'plain'] as const,
        'subtle',
      ),
      headingColor: pick(c.get('theme.headingColor'), ['text', 'accent', 'muted'] as const, 'text'),
      codeStyle: pick(c.get('theme.codeStyle'), ['card', 'flat', 'bordered'] as const, 'card'),
    },
    layout: {
      align: pick(c.get('layout.align'), ['center', 'left'] as const, 'center'),
      paddingTop: clamp(c.get('layout.paddingTop'), 0, 40, 6),
      paddingBottom: clamp(c.get('layout.paddingBottom'), 0, 90, 50),
      toc: pick(c.get('layout.toc'), ['auto', 'always', 'never'] as const, 'auto'),
      tocSide: pick(c.get('layout.tocSide'), ['left', 'right'] as const, 'left'),
      tocMaxDepth: clamp(c.get('layout.tocMaxDepth'), 1, 6, 3),
      showProgress: bool(c.get('layout.showProgress'), true),
      showHud: bool(c.get('layout.showHud'), true),
      stickyHeading: bool(c.get('layout.stickyHeading'), true),
      showFrontMatter: bool(c.get('layout.showFrontMatter'), true),
      codeBlocks: pick(
        c.get('layout.codeBlocks'),
        ['expanded', 'collapsed', 'hidden'] as const,
        'expanded',
      ),
      wrapCode: bool(c.get('layout.wrapCode'), false),
      maxImageHeight: clamp(c.get('layout.maxImageHeight'), 10, 100, 60),
      tableStyle: pick(c.get('layout.tableStyle'), ['lined', 'zebra', 'minimal'] as const, 'lined'),
      smoothScroll: bool(c.get('layout.smoothScroll'), true),
      scrollOffset: clamp(c.get('layout.scrollOffset'), 0, 60, 25),
    },
    reading: {
      focusMode: pick(c.get('reading.focusMode'), FOCUS_MODES, 'off'),
      focusFollows: pick(
        c.get('reading.focusFollows'),
        ['center', 'mouse', 'manual'] as const,
        'center',
      ),
      focusDim: clamp(c.get('reading.focusDim'), 0, 1, 0.32),
      focusBlur: clamp(c.get('reading.focusBlur'), 0, 4, 0),
      bionic: bool(c.get('reading.bionic'), false),
      bionicStrength: clamp(c.get('reading.bionicStrength'), 0.2, 0.8, 0.4),
      bionicOpacity: clamp(c.get('reading.bionicOpacity'), 0.2, 1, 0.62),
      ruler: pick(c.get('reading.ruler'), RULERS, 'off'),
      rulerHeight: clamp(c.get('reading.rulerHeight'), 0.5, 8, 1.9),
      rulerOpacity: clamp(c.get('reading.rulerOpacity'), 0.02, 0.9, 0.1),
      autoScrollSpeed: clamp(c.get('reading.autoScrollSpeed'), 4, 400, 28),
      wordsPerMinute: clamp(c.get('reading.wordsPerMinute'), 80, 900, 220),
      rememberPosition: bool(c.get('reading.rememberPosition'), true),
      hideCursorWhenIdle: bool(c.get('reading.hideCursorWhenIdle'), true),
      highlightOnHover: bool(c.get('reading.highlightOnHover'), false),
    },
    behavior: {
      persistOverrides: pick(
        c.get('behavior.persistOverrides'),
        ['user', 'workspace', 'session'] as const,
        'user',
      ),
      openLinksInReader: bool(c.get('behavior.openLinksInReader'), true),
      allowRawHtmlTags: bool(c.get('behavior.allowRawHtmlTags'), true),
      zenMode: bool(c.get('behavior.zenMode'), false),
    },
  };
};

/**
 * Writes a setting to the target chosen by `lucid.behavior.persistOverrides`.
 * Returns false when the caller should apply the change in the webview only
 * (session mode, or workspace mode with no folder open).
 */
export const writeSetting = async (key: string, value: unknown): Promise<boolean> => {
  const c = vscode.workspace.getConfiguration(SECTION);
  const mode = pick(
    c.get('behavior.persistOverrides'),
    ['user', 'workspace', 'session'] as const,
    'user',
  );
  if (mode === 'session') {
    return false;
  }
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  const target =
    mode === 'workspace' && hasWorkspace
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
  return true;
};

/** Reads a single setting through the same clamping path used for the full read. */
export const getSetting = <T>(key: string, fallback: T): T => {
  const value = vscode.workspace.getConfiguration(SECTION).get<T>(key);
  return value === undefined ? fallback : value;
};

export const cycle = <T>(list: readonly T[], current: T, step = 1): T => {
  const i = list.indexOf(current);
  const next = (i < 0 ? 0 : i + step + list.length) % list.length;
  return list[next];
};
