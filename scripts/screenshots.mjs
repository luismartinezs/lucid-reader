/**
 * Marketplace screenshots.
 *
 * The Marketplace listing is README.md verbatim, so the extension needs real
 * pictures of the reading view. Rather than photograph a running VS Code
 * window by hand, this script loads the two files that decide what the reader
 * looks like (out/markdown.js for the document HTML, media/reader.js plus
 * media/reader.css for the runtime) into headless Chrome, feeds them the same
 * `render` message the extension host would post, and captures the result.
 *
 * The `vscode` module does not exist outside the extension host, so it is
 * stubbed below: settings come back undefined, which makes readConfig() return
 * exactly the defaults declared in package.json.
 *
 * Usage: npm run shots
 */

import Module from 'node:module';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------- vscode stub */

const uri = (fsPath) => ({
  fsPath,
  toString: () => `file://${fsPath}`,
});

const vscodeStub = {
  Uri: {
    file: uri,
    joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    getWorkspaceFolder: () => undefined,
  },
  window: { activeColorTheme: { kind: 1 } },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return load.call(this, request, ...rest);
};

/* ------------------------------------------------------------ build inputs */

const { readConfig } = require(path.join(root, 'out', 'config.js'));
const { render } = require(path.join(root, 'out', 'markdown.js'));
const { buildShell } = require(path.join(root, 'out', 'webview.js'));

const webviewStub = {
  cspSource: 'file:',
  asWebviewUri: (u) => u.toString(),
};

const SHOTS = [
  { name: 'reading-view', theme: 'paper', source: 'docs/screenshot-prose.md' },
  { name: 'reading-view-dark', theme: 'midnight', source: 'docs/screenshot-prose.md' },
  { name: 'kitchen-sink', theme: 'sepia', source: 'docs/kitchen-sink.md' },
];

const WIDTH = 1440;
const HEIGHT = 900;

const chrome = ['google-chrome', 'google-chrome-stable', 'chromium'].find((bin) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

if (!chrome) {
  console.error('No Chrome binary found. Install google-chrome or chromium.');
  process.exit(1);
}

const outDir = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-shots-'));

for (const shot of SHOTS) {
  const config = readConfig();
  config.theme.name = shot.theme;

  const markdown = fs.readFileSync(path.join(root, shot.source), 'utf8');
  const result = render(markdown, {
    smartQuotes: config.typography.smartQuotes,
    smartDashes: config.typography.smartDashes,
    allowRawHtmlTags: config.behavior.allowRawHtmlTags,
  });

  const payload = {
    type: 'render',
    html: result.html,
    headings: result.headings,
    words: result.words,
    frontMatter: result.frontMatter,
    title: path.basename(shot.source),
    config,
  };

  // The real shell carries a Content-Security-Policy that only trusts the
  // webview origin, which a file:// page cannot satisfy. Everything else about
  // the shell is kept so the screenshot cannot drift from the real markup.
  const shell = buildShell(webviewStub, uri(root))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace(
      '<script nonce',
      `<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });</script>
<script nonce`,
    )
    .replace(
      '</body>',
      `<script>window.postMessage(${JSON.stringify(payload)}, '*');</script>
</body>`,
    );

  const page = path.join(tmpDir, `${shot.name}.html`);
  fs.writeFileSync(page, shell);

  const target = path.join(outDir, `${shot.name}.png`);
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--virtual-time-budget=2000',
      `--screenshot=${target}`,
      `file://${page}`,
    ],
    { stdio: 'ignore' },
  );

  // Chrome captures at device scale 2, which is sharp but heavy. The README is
  // served from GitHub raw, so each image is halved in width and quantised to a
  // palette before it lands in the repository. Both steps are skipped rather
  // than failed when the tools are not installed.
  shrink(target);

  console.log(`wrote ${path.relative(root, target)} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
}

function has(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function shrink(file) {
  if (has('convert')) {
    execFileSync('convert', [file, '-resize', `${WIDTH * 1.5}x`, '-strip', file], { stdio: 'ignore' });
  }
  if (has('pngquant')) {
    execFileSync('pngquant', ['--quality=75-96', '--speed', '1', '--force', '--output', file, file], {
      stdio: 'ignore',
    });
  }
}
