/**
 * Extension host: custom editor registration, command surface, message routing.
 *
 * Design notes:
 * - The reader is a CustomTextEditorProvider, not a webview panel. That means
 *   it is a real editor tab (so Ctrl+P, tab groups, and "Reopen Editor With"
 *   all behave), it receives unsaved buffer changes for free, and closing the
 *   tab is the same gesture as closing any other file.
 * - Commands never touch the webview directly. They write settings; the
 *   configuration listener broadcasts the new config to every live panel. One
 *   path in, one path out, so the palette, keybindings, and in-reader keys can
 *   never drift out of sync.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  FONT_PRESETS,
  FOCUS_MODES,
  RULERS,
  THEMES,
  cycle,
  getSetting,
  readConfig,
  writeSetting,
} from './config';
import { render } from './markdown';
import { buildShell, rewriteAssets } from './webview';

const VIEW_TYPE = 'lucid.reader';
const POSITION_KEY = 'lucid.positions';

type Live = {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
};

const live = new Set<Live>();

/* --------------------------------------------------------------- rendering */

const renderDocument = (
  document: vscode.TextDocument,
  panel: vscode.WebviewPanel,
): Record<string, unknown> => {
  const config = readConfig(document.uri);
  const result = render(document.getText(), {
    smartQuotes: config.typography.smartQuotes,
    smartDashes: config.typography.smartDashes,
    allowRawHtmlTags: config.behavior.allowRawHtmlTags,
  });
  return {
    type: 'render',
    html: rewriteAssets(result.html, panel.webview, document.uri),
    headings: result.headings,
    words: result.words,
    frontMatter: result.frontMatter,
    title: path.basename(document.uri.fsPath),
    config,
  };
};

const broadcastConfig = (): void => {
  for (const entry of live) {
    void entry.panel.webview.postMessage({
      type: 'config',
      config: readConfig(entry.document.uri),
    });
  }
};

/** Re-render every open reader. Used when a setting changes parser behaviour. */
const broadcastRender = (): void => {
  for (const entry of live) {
    void entry.panel.webview.postMessage(renderDocument(entry.document, entry.panel));
  }
};

/* ------------------------------------------------------------ link handling */

const openLink = async (href: string, docUri: vscode.Uri): Promise<void> => {
  if (/^(https?|mailto):/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const [rawPath, fragment] = href.split('#');
  if (!rawPath) {
    return; // pure anchor, handled inside the webview
  }
  const base = path.dirname(docUri.fsPath);
  const target = vscode.Uri.file(
    path.resolve(
      rawPath.startsWith('/')
        ? (vscode.workspace.getWorkspaceFolder(docUri)?.uri.fsPath ?? base)
        : base,
      rawPath.replace(/^\/+/, ''),
    ),
  );

  try {
    await vscode.workspace.fs.stat(target);
  } catch {
    void vscode.window.showWarningMessage(`Lucid: cannot find ${rawPath}`);
    return;
  }

  const isMarkdown = /\.(md|markdown|mdx|mdown|mkd)$/i.test(target.fsPath);
  if (isMarkdown && getSetting('behavior.openLinksInReader', true)) {
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    return;
  }
  if (isMarkdown || /\.(txt|json|ya?ml|toml|ts|js|py|sh|css|html)$/i.test(target.fsPath)) {
    const doc = await vscode.workspace.openTextDocument(target);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (fragment) {
      const line = doc
        .getText()
        .split('\n')
        .findIndex((l) => /^#{1,6}\s/.test(l) && slugMatches(l, fragment));
      if (line >= 0) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
      }
    }
    return;
  }
  await vscode.env.openExternal(target);
};

const slugMatches = (headingLine: string, fragment: string): boolean =>
  headingLine
    .replace(/^#{1,6}\s+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-') === decodeURIComponent(fragment).toLowerCase();

/* -------------------------------------------------------------- the editor */

const makeProvider = (context: vscode.ExtensionContext): vscode.CustomTextEditorProvider => ({
  resolveCustomTextEditor: async (document, panel) => {
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        context.extensionUri,
        docDir,
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
      ],
    };
    panel.webview.html = buildShell(panel.webview, context.extensionUri);

    const entry: Live = { panel, document };
    live.add(entry);

    if (readConfig(document.uri).behavior.zenMode) {
      void vscode.commands.executeCommand('workbench.action.toggleZenMode');
    }

    const positions = context.workspaceState.get<Record<string, number>>(POSITION_KEY) ?? {};
    const savedRatio = positions[document.uri.toString()] ?? 0;

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        void panel.webview.postMessage(renderDocument(document, panel));
      }
    });

    const messageSub = panel.webview.onDidReceiveMessage(async (msg: Record<string, any>) => {
      switch (msg.type) {
        case 'ready': {
          void panel.webview.postMessage({
            ...renderDocument(document, panel),
            restoreRatio: readConfig(document.uri).reading.rememberPosition ? savedRatio : 0,
          });
          return;
        }
        case 'set': {
          const persisted = await writeSetting(String(msg.key), msg.value);
          if (!persisted) {
            // Session mode: apply to this panel only, nothing hits settings.json.
            void panel.webview.postMessage({ type: 'patch', key: msg.key, value: msg.value });
          }
          return;
        }
        case 'link': {
          await openLink(String(msg.href), document.uri);
          return;
        }
        case 'position': {
          const store = context.workspaceState.get<Record<string, number>>(POSITION_KEY) ?? {};
          store[document.uri.toString()] = Number(msg.ratio) || 0;
          void context.workspaceState.update(POSITION_KEY, store);
          return;
        }
        case 'edit': {
          const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: false,
          });
          const line = Math.max(0, Math.min(document.lineCount - 1, Number(msg.line) || 0));
          const pos = new vscode.Position(line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          return;
        }
        case 'copy': {
          await vscode.env.clipboard.writeText(String(msg.text));
          return;
        }
        case 'settings': {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'lucid.');
          return;
        }
        default:
          return;
      }
    });

    panel.onDidDispose(() => {
      live.delete(entry);
      changeSub.dispose();
      messageSub.dispose();
    });
  },
});

/* ---------------------------------------------------------------- commands */

const activeMarkdownUri = (): vscode.Uri | undefined => {
  const editor = vscode.window.activeTextEditor;
  if (editor && /\.(md|markdown|mdx|mdown|mkd)$/i.test(editor.document.uri.fsPath)) {
    return editor.document.uri;
  }
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri };
  return tab?.uri;
};

const bump = async (key: string, delta: number, min: number, max: number, fallback: number) => {
  const current = getSetting(key, fallback);
  const next = Math.round(Math.min(max, Math.max(min, current + delta)) * 100) / 100;
  await writeSetting(key, next);
  return next;
};

const notify = (text: string): void => {
  void vscode.window.setStatusBarMessage(`Lucid: ${text}`, 1800);
};

export const activate = (context: vscode.ExtensionContext): void => {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, makeProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('lucid')) {
        return;
      }
      const needsReparse =
        e.affectsConfiguration('lucid.typography.smartQuotes') ||
        e.affectsConfiguration('lucid.typography.smartDashes') ||
        e.affectsConfiguration('lucid.behavior.allowRawHtmlTags');
      if (needsReparse) {
        broadcastRender();
      } else {
        broadcastConfig();
      }
    }),
  );

  const register = (name: string, fn: (...args: any[]) => any): void => {
    context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  };

  register('lucid.open', async (resource?: vscode.Uri) => {
    const uri = resource instanceof vscode.Uri ? resource : activeMarkdownUri();
    if (!uri) {
      void vscode.window.showInformationMessage('Lucid: open a Markdown file first.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  });

  register('lucid.openToSide', async (resource?: vscode.Uri) => {
    const uri = resource instanceof vscode.Uri ? resource : activeMarkdownUri();
    if (!uri) {
      void vscode.window.showInformationMessage('Lucid: open a Markdown file first.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.Beside);
  });

  register('lucid.toggleFocusMode', async () => {
    const next = cycle(FOCUS_MODES, getSetting('reading.focusMode', 'off') as any);
    await writeSetting('reading.focusMode', next);
    notify(`focus ${next}`);
  });

  register('lucid.toggleBionic', async () => {
    const next = !getSetting('reading.bionic', false);
    await writeSetting('reading.bionic', next);
    notify(`bionic ${next ? 'on' : 'off'}`);
  });

  register('lucid.toggleRuler', async () => {
    const next = cycle(RULERS, getSetting('reading.ruler', 'off') as any);
    await writeSetting('reading.ruler', next);
    notify(`ruler ${next}`);
  });

  register('lucid.cycleTheme', async () => {
    const next = cycle(THEMES, getSetting('theme.name', 'auto') as any);
    await writeSetting('theme.name', next);
    notify(`theme ${next}`);
  });

  register('lucid.cycleFont', async () => {
    const next = cycle(FONT_PRESETS, getSetting('typography.fontPreset', 'serif') as any);
    await writeSetting('typography.fontPreset', next);
    notify(`font ${next}`);
  });

  register('lucid.increaseFontSize', async () => {
    notify(`${await bump('typography.fontSize', 1, 10, 48, 19)}px`);
  });
  register('lucid.decreaseFontSize', async () => {
    notify(`${await bump('typography.fontSize', -1, 10, 48, 19)}px`);
  });
  register('lucid.resetFontSize', async () => {
    await writeSetting('typography.fontSize', 19);
    notify('19px');
  });
  register('lucid.increaseMeasure', async () => {
    notify(`${await bump('typography.measure', 2, 30, 140, 68)}ch`);
  });
  register('lucid.decreaseMeasure', async () => {
    notify(`${await bump('typography.measure', -2, 30, 140, 68)}ch`);
  });
  register('lucid.increaseLineHeight', async () => {
    notify(`line height ${await bump('typography.lineHeight', 0.05, 1, 3, 1.7)}`);
  });
  register('lucid.decreaseLineHeight', async () => {
    notify(`line height ${await bump('typography.lineHeight', -0.05, 1, 3, 1.7)}`);
  });

  register('lucid.toggleToc', async () => {
    const current = getSetting<string>('layout.toc', 'auto');
    await writeSetting('layout.toc', current === 'never' ? 'always' : 'never');
  });

  register('lucid.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'lucid.');
  });

  register('lucid.resetSettings', async () => {
    const answer = await vscode.window.showWarningMessage(
      'Reset every Lucid reader setting to its default?',
      { modal: true },
      'Reset',
    );
    if (answer !== 'Reset') {
      return;
    }
    const c = vscode.workspace.getConfiguration('lucid');
    const keys = [
      'typography.fontPreset', 'typography.customFontFamily', 'typography.headingFontFamily',
      'typography.codeFontFamily', 'typography.fontSize', 'typography.fontWeight',
      'typography.lineHeight', 'typography.measure', 'typography.letterSpacing',
      'typography.wordSpacing', 'typography.paragraphSpacing', 'typography.paragraphIndent',
      'typography.textAlign', 'typography.hyphens', 'typography.headingScale',
      'typography.balanceHeadings', 'typography.prettyWrap', 'typography.hangingPunctuation',
      'typography.smartQuotes', 'typography.smartDashes', 'typography.dropCap',
      'theme.name', 'theme.customColors', 'theme.textContrast', 'theme.linkStyle',
      'theme.headingColor', 'theme.codeStyle',
      'layout.align', 'layout.paddingTop', 'layout.paddingBottom', 'layout.toc',
      'layout.tocSide', 'layout.tocMaxDepth', 'layout.showProgress', 'layout.showHud',
      'layout.stickyHeading', 'layout.showFrontMatter', 'layout.codeBlocks', 'layout.wrapCode',
      'layout.maxImageHeight', 'layout.tableStyle', 'layout.smoothScroll', 'layout.scrollOffset',
      'reading.focusMode', 'reading.focusFollows', 'reading.focusDim', 'reading.focusBlur',
      'reading.bionic', 'reading.bionicStrength', 'reading.bionicOpacity', 'reading.ruler',
      'reading.rulerHeight', 'reading.rulerOpacity', 'reading.autoScrollSpeed',
      'reading.wordsPerMinute', 'reading.rememberPosition', 'reading.hideCursorWhenIdle',
      'reading.highlightOnHover',
      'behavior.persistOverrides', 'behavior.openLinksInReader', 'behavior.allowRawHtmlTags',
      'behavior.zenMode',
    ];
    for (const key of keys) {
      await c.update(key, undefined, vscode.ConfigurationTarget.Global);
      await c.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    }
    notify('settings reset');
  });

  // Commands that only make sense inside a reader are forwarded to the panel.
  const forward = (name: string, action: string): void => {
    register(name, () => {
      for (const entry of live) {
        if (entry.panel.active) {
          void entry.panel.webview.postMessage({ type: 'action', action });
          return;
        }
      }
      void vscode.window.showInformationMessage('Lucid: focus a reader tab first.');
    });
  };
  forward('lucid.find', 'find');
  forward('lucid.toggleAutoScroll', 'autoscroll');
  forward('lucid.editSource', 'edit');
};

export const deactivate = (): void => {
  live.clear();
};
