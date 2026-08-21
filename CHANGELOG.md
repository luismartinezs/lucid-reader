# Changelog

## Unreleased

- Added ten reading palettes, bringing the total to seventeen plus `auto` and
  `custom`. Light: `parchment`, `dawn`, `sage`, `mist`, `newsprint`. Dark:
  `midnight`, `ocean`, `forest`, `ember`, `plum`. Every new palette clears the
  same contrast band as the existing ones (body text at or above 9:1 against
  its own background, accent at or above 5.5:1).
- The theme list is now ordered light to dark, so `t` walks a family before it
  jumps between light and dark.
- Added a theme picker: `T` in the reader, or the `Lucid: Pick Reading Theme`
  command. Arrow keys preview a palette on the document behind it without
  writing to settings.json, `Enter` keeps it, `Esc` restores the palette you
  opened with.
- The webview now survives a shell that predates media/reader.js. VS Code keeps
  the loaded copy of out/webview.js in the extension host until the window is
  reloaded, while the webview fetches media/reader.js from disk on every open,
  so reinstalling in place pairs an old shell with a new script. Startup wiring
  used to throw on the missing element, which skipped the `ready` post, so the
  extension never sent the document and the reader stayed empty. Startup now
  skips chrome it cannot find and always completes the handshake.

- Added a Wrap / Unwrap button in the code block caption, next to Copy. It
  toggles `lucid.layout.wrapCode` without a trip to the settings UI, so long
  lines stop scrolling sideways. Like every other in-reader control it writes
  the setting, which means it applies to every open reader in every window and
  persists across restarts.

## 0.1.1

- Fixed: headings were unreadable on every dark theme. `--heading-color` was
  written onto `<html>`, where `var(--fg)` resolves against the `:root` light
  fallback instead of the active palette on `<body>`.
- Every theme now carries a dedicated `--heading-fg`, brighter than body text on
  dark schemes and darker on light ones.
- Raised contrast across the dark, dim, and black palettes. All eleven palettes
  now clear WCAG AA for text and AA large for secondary chrome.
- Added `heading` to `lucid.theme.customColors`.

## 0.1.0

- Initial release.
