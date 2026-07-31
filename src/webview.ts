/**
 * Webview shell + asset URL rewriting.
 *
 * The shell is rendered once per panel and never reloaded. Document content
 * arrives over postMessage, which is what makes live re-render on save feel
 * instant and lets the webview keep its scroll position and runtime state.
 */

import * as path from 'path';
import * as vscode from 'vscode';

export const makeNonce = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
};

const isExternal = (url: string): boolean =>
  /^(https?:|data:|mailto:|vscode:|command:|#)/i.test(url);

/**
 * Rewrites relative `src`/`href` values so images resolve inside the webview
 * sandbox. Links stay relative on purpose: the click handler in the extension
 * resolves them against the document so it can decide between "open in reader",
 * "open in editor", and "open in browser".
 */
export const rewriteAssets = (
  html: string,
  webview: vscode.Webview,
  docUri: vscode.Uri,
): string => {
  const dir = vscode.Uri.file(path.dirname(docUri.fsPath));
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (whole, pre: string, url: string, post: string) => {
    if (isExternal(url)) {
      return whole;
    }
    const target = url.startsWith('/')
      ? vscode.Uri.joinPath(
          vscode.workspace.getWorkspaceFolder(docUri)?.uri ?? dir,
          url.replace(/^\/+/, ''),
        )
      : vscode.Uri.joinPath(dir, decodeURIComponent(url.split(/[?#]/)[0]));
    return `${pre}${webview.asWebviewUri(target).toString()}${post}`;
  });
};

export const buildShell = (webview: vscode.Webview, extensionUri: vscode.Uri): string => {
  const nonce = makeNonce();
  const asset = (...parts: string[]): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} https: data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('media', 'reader.css')}">
<title>Lucid Reader</title>
</head>
<body data-theme="auto">
  <div id="progress" aria-hidden="true"><span id="progress-fill"></span></div>

  <nav id="toc" aria-label="Outline">
    <div id="toc-head">Outline</div>
    <ol id="toc-list"></ol>
  </nav>

  <div id="crumb" aria-hidden="true"><span id="crumb-text"></span></div>

  <main id="scroller" tabindex="0">
    <article id="doc"></article>
  </main>

  <div id="ruler" aria-hidden="true"></div>
  <div id="spotlight-top" aria-hidden="true"></div>
  <div id="spotlight-bottom" aria-hidden="true"></div>

  <footer id="hud" aria-live="off">
    <span id="hud-progress">0%</span>
    <span class="hud-sep">·</span>
    <span id="hud-time">–</span>
    <span class="hud-sep">·</span>
    <span id="hud-words">0 words</span>
    <span class="hud-sep">·</span>
    <button id="hud-help" type="button" title="Keyboard shortcuts">?</button>
  </footer>

  <div id="find" role="search" hidden>
    <input id="find-input" type="text" placeholder="Find in document" spellcheck="false" autocomplete="off">
    <span id="find-count">0/0</span>
    <button id="find-prev" type="button" title="Previous (Shift+Enter)">↑</button>
    <button id="find-next" type="button" title="Next (Enter)">↓</button>
    <button id="find-close" type="button" title="Close (Esc)">✕</button>
  </div>

  <div id="help" hidden>
    <div id="help-card">
      <h2>Reading controls</h2>
      <dl id="help-list"></dl>
      <p class="help-foot">Every shortcut has a matching setting under <code>lucid.*</code>. Press <kbd>,</kbd> to open them.</p>
      <button id="help-close" type="button">Close</button>
    </div>
  </div>

  <div id="toast" aria-live="polite"></div>

  <script nonce="${nonce}" src="${asset('media', 'reader.js')}"></script>
</body>
</html>`;
};
