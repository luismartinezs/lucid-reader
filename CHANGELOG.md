# Changelog

## Unreleased

- Added a per-block Wrap / Unwrap button in the code block caption, next to
  Copy. It overrides `lucid.layout.wrapCode` for that one block, so a single
  long line no longer means scrolling sideways or flipping a global setting.

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
