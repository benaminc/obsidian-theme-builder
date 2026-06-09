# Folder Themer

An Obsidian plugin that colors **folder and note titles** in the file-explorer
sidebar from a palette you define, applied in a **rotating** fashion — with
**restart points** that begin a fresh rotation for nested subfolders.

## Behavior

- Each top-level folder gets the next color in the palette; the palette wraps
  around when there are more folders than colors.
- A folder's **notes and subfolders inherit its color** — the whole branch is
  one color…
- …**except at a restart folder**, where the direct **subfolders** start a
  fresh pass through the palette (so a deep tree can have nested color groups).
  Notes directly inside a restart folder keep the restart folder's own color.

## How it works (no magic, no dependencies)

This plugin is a single hand-written `main.js` (CommonJS). It has **zero npm
dependencies** and **no build step** — Obsidian provides the `obsidian` module
at runtime and loads `main.js` directly.

Colors are applied by generating a `<style>` element that targets the
`data-path` attribute Obsidian puts on every explorer row:

```css
.nav-folder-title[data-path="Projects"]      { color: #61afef; } /* the folder */
.nav-file-title[data-path^="Projects/"]       { color: #61afef; } /* its contents */
```

Rules are emitted shallow→deep, so a nested folder's longer-prefix rule
overrides its parent for its own contents. That inheritance is pure CSS, so it
survives the file explorer's constant re-rendering and applies even to
collapsed folders.

## Settings

- **Enable folder coloring** — master switch.
- **Color note titles too** — folders only, or folders + notes.
- **Colored indent guides** — recolor Obsidian's native indent guide lines
  (`--nav-indentation-guide-color`) to match each branch. Nested folders and
  restart points stack guides in their own colors.
- **Palette** — add / remove / reorder colors with a native color picker.
  Order drives the rotation.
- **Restart folders** — pick folders where the rotation restarts.
- **App theme** — spread the palette across the whole interface:
  - The first color drives Obsidian's accent (links, buttons, toggles,
    selection, focus rings) by feeding its native `--accent-h/-s/-l` engine.
  - **Color headings** cycles H1–H6 through the palette.
  - **Color tags & callouts** tints tags, highlights, and blockquote/callout
    borders.
  - **Tint app chrome** washes the sidebars, title bar, status bar, and ribbon
    with palette color 1 (strength adjustable) so the whole window reads as
    themed. The editor/note background (`--background-primary`) stays neutral
    for readability.
  - Per-mode contrast nudging (via `color-mix`) keeps colors legible in both
    light and dark.
  - Fully scoped to `body.folder-themer-app-theme`, so toggling it off cleanly
    removes everything.

There is also a command: **Folder Themer: Refresh folder colors**.

## Install (manual / dev)

Copy or symlink this folder into your vault at
`<vault>/.obsidian/plugins/folder-themer/`, then enable it under
Settings → Community plugins.

## Notes / limitations

- Sibling order follows Obsidian's **default name sort** (case-insensitive,
  numeric-aware). Custom file-explorer sort modes aren't tracked yet (would
  require private API).
- Notes sitting directly in the **vault root** (not in any folder) are left at
  the default color.

## Privacy

This plugin runs entirely locally. It makes **no network requests**, loads no
remote assets, and collects or transmits **no data or telemetry**. All it does
is read your vault's folder structure and inject CSS to color the interface.

## License

Released under the [MIT License](LICENSE).
