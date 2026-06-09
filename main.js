'use strict';

/*
 * Folder Themer — color file-explorer folders (and the notes inside them)
 * from a rotating palette, with restart points that begin a fresh rotation
 * for nested subfolders.
 *
 * Zero dependencies. The `obsidian` module is provided by Obsidian at runtime.
 * No build step: this CommonJS file is loaded directly.
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, TFolder } = obsidian;

const FOLDER_STYLE_ID = 'folder-themer-folders';
const APP_THEME_STYLE_ID = 'folder-themer-app-theme';
const REFRESH_DEBOUNCE_MS = 100;

const DEFAULT_SETTINGS = {
  enabled: true,
  colorFiles: true,
  // Recolor Obsidian's native indent guides to match each branch's color.
  accentBars: true,
  accentBarWidth: 2,
  // Palette applied in order; rotation wraps around this list.
  palette: ['#e06c75', '#98c379', '#61afef', '#c678dd', '#e5c07b'],
  // Folder paths where the color rotation restarts for direct subfolders.
  restartFolders: [],
  // Whole-app accent theme derived from the palette (off by default).
  applyAppTheme: false,
  themeColorHeadings: true,
  themeColorTags: true,
  // Wash the app chrome (sidebars, title bar, status bar, ribbon) with the
  // primary color. Editor/note background stays neutral.
  tintChrome: true,
  chromeTintStrength: 14,
};

/**
 * Sibling sort. Isolated here so the ordering rule is easy to change.
 * Approximates Obsidian's default "name (A→Z)" sort: case-insensitive,
 * numeric-aware. (Honoring custom file-explorer sort modes would require
 * private API and is intentionally out of scope.)
 */
function compareSiblings(a, b) {
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/** Escape a value for use inside a double-quoted CSS attribute selector. */
function cssAttr(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Convert a #rgb / #rrggbb hex string to {h, s, l} (h in degrees, s/l in %).
 * Used to feed Obsidian's accent engine (--accent-h/-s/-l). Returns null on a
 * value we can't parse. No dependencies.
 */
function hexToHsl(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;

  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let hue = 0;
  let sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hue = (b - r) / d + 2;
        break;
      default:
        hue = (r - g) / d + 4;
    }
    hue /= 6;
  }

  return {
    h: Math.round(hue * 360),
    s: Math.round(sat * 100),
    l: Math.round(l * 100),
  };
}

class FolderThemerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.folderStyleEl = this.createStyleEl(FOLDER_STYLE_ID);
    this.appThemeStyleEl = this.createStyleEl(APP_THEME_STYLE_ID);

    this.addSettingTab(new FolderThemerSettingTab(this.app, this));

    this.addCommand({
      id: 'refresh-folder-colors',
      name: 'Refresh folder colors',
      callback: () => this.refresh(),
    });

    // Initial paint once the layout (and file explorer) is ready.
    this.app.workspace.onLayoutReady(() => this.refresh());

    // Recompute when the vault structure or layout changes.
    this.registerEvent(this.app.vault.on('create', () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh()));
    this.registerEvent(
      this.app.workspace.on('layout-change', () => this.scheduleRefresh())
    );
  }

  onunload() {
    if (this.folderStyleEl) this.folderStyleEl.remove();
    if (this.appThemeStyleEl) this.appThemeStyleEl.remove();
    document.body.classList.remove('folder-themer-app-theme');
    window.clearTimeout(this._refreshTimer);
  }

  createStyleEl(id) {
    const el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
    return el;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refresh();
  }

  scheduleRefresh() {
    window.clearTimeout(this._refreshTimer);
    this._refreshTimer = window.setTimeout(
      () => this.refresh(),
      REFRESH_DEBOUNCE_MS
    );
  }

  refresh() {
    const colors = this.settings.enabled ? this.computeFolderColors() : [];
    this.applyFolderColors(colors);
    this.applyAppTheme();
  }

  /**
   * Walk the vault tree and assign a color to every folder.
   * Rotation restarts at the vault root and at any restart folder; everywhere
   * else, subfolders inherit their parent's color.
   * @returns {Array<{path: string, color: string}>} shallow→deep order.
   */
  computeFolderColors() {
    const palette = this.settings.palette.filter((c) => !!c);
    const restart = new Set(this.settings.restartFolders);
    const result = [];

    if (palette.length === 0) return result;

    const root = this.app.vault.getRoot();

    const visit = (folder, inheritedColor) => {
      const subfolders = folder.children
        .filter((child) => child instanceof TFolder)
        .sort(compareSiblings);

      const rotates = folder === root || restart.has(folder.path);

      subfolders.forEach((sub, i) => {
        const color = rotates ? palette[i % palette.length] : inheritedColor;
        result.push({ path: sub.path, color });
        visit(sub, color);
      });
    };

    visit(root, palette[0]);

    // Shallowest first so deeper prefix rules win for nested contents.
    result.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    return result;
  }

  applyFolderColors(colors) {
    if (!this.folderStyleEl) return;

    const rules = [];

    // Make sure the native nav indent guides are visible (themes may zero
    // their width). Only when the accent-bar feature is on.
    if (this.settings.accentBars && colors.length) {
      const w = Number(this.settings.accentBarWidth) || 2;
      rules.push(`.nav-files-container{--nav-indentation-guide-width:${w}px;}`);
    }

    for (const { path, color } of colors) {
      const sel = cssAttr(path);
      // Folder's own title (exact path match).
      rules.push(
        `.nav-folder-title[data-path="${sel}"]{color:${color};}`
      );
      // Notes (and, via override ordering, subfolders) inside this folder.
      if (this.settings.colorFiles) {
        rules.push(
          `.nav-file-title[data-path^="${sel}/"]{color:${color};}`
        );
      }
      // Recolor the native indent guide for this folder's contents. Because
      // each folder's children container gets its own rule, nested branches
      // (and restart points) show stacked guides in their own colors.
      if (this.settings.accentBars) {
        rules.push(
          `.nav-folder-title[data-path="${sel}"] + .nav-folder-children{--nav-indentation-guide-color:${color};}`
        );
      }
    }

    this.folderStyleEl.textContent = rules.join('\n');
  }

  /**
   * Whole-app accent theme derived from the palette. Backgrounds are left
   * untouched ("accent only"); the palette is spread across UI roles and the
   * theme covers both light and dark via per-mode contrast nudging.
   */
  applyAppTheme() {
    if (!this.appThemeStyleEl) return;

    if (!this.settings.applyAppTheme) {
      this.appThemeStyleEl.textContent = '';
      document.body.classList.remove('folder-themer-app-theme');
      return;
    }

    const css = this.buildAppThemeCSS();
    this.appThemeStyleEl.textContent = css;
    document.body.classList.toggle('folder-themer-app-theme', css !== '');
  }

  /**
   * Build the app-theme stylesheet text. Scoped to body.folder-themer-app-theme
   * so it is fully reversible and never leaks into other vaults/windows.
   */
  buildAppThemeCSS() {
    const palette = this.settings.palette.filter((c) => !!c);
    if (palette.length === 0) return '';

    const pick = (i) => palette[i % palette.length];
    const blocks = [];

    // --- Primary accent: drives links, buttons, toggles, focus rings, etc. ---
    // Feeding Obsidian's own accent engine recolors the whole accent system
    // natively and consistently across both appearance modes.
    const base = palette[0];
    const hsl = hexToHsl(base);
    const baseDecls = [];
    // Feed the HSL accent engine (drives Obsidian's derived accent shades)...
    if (hsl) {
      baseDecls.push(`--accent-h:${hsl.h};`);
      baseDecls.push(`--accent-s:${hsl.s}%;`);
      baseDecls.push(`--accent-l:${hsl.l}%;`);
    }
    // ...and also set the concrete semantic accents directly, so links and
    // buttons recolor even if a theme hardcodes these instead of deriving them.
    const accentHover = `color-mix(in srgb, ${base} 88%, white)`;
    baseDecls.push(`--interactive-accent:${base};`);
    baseDecls.push(`--interactive-accent-hover:${accentHover};`);
    baseDecls.push(`--text-accent:${base};`);
    baseDecls.push(`--text-accent-hover:${accentHover};`);
    blocks.push(`body.folder-themer-app-theme{${baseDecls.join('')}}`);

    // --- Roles spread across the palette, nudged for contrast per mode. ---
    // `toward`/`amt` pull each role color toward black (light mode) or white
    // (dark mode) just enough to stay legible on the untinted background.
    const roleDecls = (toward, amt) => {
      const adj = (c) =>
        amt > 0 ? `color-mix(in srgb, ${c} ${100 - amt}%, ${toward})` : c;
      const d = [];

      if (this.settings.themeColorHeadings) {
        for (let i = 1; i <= 6; i++) d.push(`--h${i}-color:${adj(pick(i - 1))};`);
      }

      if (this.settings.themeColorTags) {
        const tag = pick(1);
        d.push(`--tag-color:${adj(tag)};`);
        d.push(`--tag-color-hover:${adj(tag)};`);
        d.push(`--tag-background:color-mix(in srgb, ${tag} 15%, transparent);`);
        d.push(
          `--tag-background-hover:color-mix(in srgb, ${tag} 25%, transparent);`
        );
        d.push(`--blockquote-border-color:${adj(pick(2))};`);
        d.push(
          `--text-highlight-bg:color-mix(in srgb, ${pick(3)} 35%, transparent);`
        );
      }

      return d.join('');
    };

    // --- Chrome tint: wash sidebars/title bar/status bar/ribbon with the base
    // color. Mixed against a per-mode neutral so brightness stays close to the
    // default surfaces; --background-primary (the editor) is deliberately left
    // alone so notes stay readable. ---
    const chromeDecls = (neutral, alt) => {
      if (!this.settings.tintChrome) return '';
      const s = Math.max(0, Math.min(60, Number(this.settings.chromeTintStrength) || 0));
      if (s === 0) return '';
      const tint = (n) => `color-mix(in srgb, ${base} ${s}%, ${n})`;
      return [
        `--background-secondary:${tint(neutral)};`,
        `--background-secondary-alt:${tint(alt)};`,
        `--titlebar-background:${tint(alt)};`,
        `--titlebar-background-focused:${tint(neutral)};`,
        `--status-bar-background:${tint(alt)};`,
        `--ribbon-background:${tint(alt)};`,
      ].join('');
    };

    // Dark: keep colors vivid (tiny lift toward white). Light: darken for read.
    blocks.push(
      `body.theme-dark.folder-themer-app-theme{${roleDecls('white', 8)}${chromeDecls(
        '#1e1e1e',
        '#171717'
      )}}`
    );
    blocks.push(
      `body.theme-light.folder-themer-app-theme{${roleDecls('black', 18)}${chromeDecls(
        '#ececf0',
        '#e2e2e8'
      )}}`
    );

    return blocks.join('\n');
  }
}

class FolderThemerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Enable folder coloring')
      .setDesc('Master switch. When off, all custom colors are removed.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Color note titles too')
      .setDesc('When off, only folder titles are colored; notes stay default.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.colorFiles).onChange(async (v) => {
          this.plugin.settings.colorFiles = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Colored indent guides')
      .setDesc(
        "Recolor Obsidian's native indent guide lines to match each branch. " +
          'Nested folders and restart points stack guides in their own colors.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.accentBars).onChange(async (v) => {
          this.plugin.settings.accentBars = v;
          await this.plugin.saveSettings();
        })
      );

    this.renderPalette(containerEl);
    this.renderRestartFolders(containerEl);
    this.renderAppTheme(containerEl);
  }

  renderPalette(containerEl) {
    new Setting(containerEl).setName('Palette').setHeading();

    const desc = containerEl.createEl('p', {
      text:
        'Colors are applied to top-level folders in this order and wrap around. ' +
        'Order matters — use the arrows to reorder.',
      cls: 'setting-item-description folder-themer-note',
    });
    const palette = this.plugin.settings.palette;

    palette.forEach((color, index) => {
      const row = new Setting(containerEl).setName(`Color ${index + 1}`);

      row.addColorPicker((picker) =>
        picker.setValue(color).onChange(async (v) => {
          this.plugin.settings.palette[index] = v;
          await this.plugin.saveSettings();
        })
      );

      row.addExtraButton((btn) =>
        btn
          .setIcon('arrow-up')
          .setTooltip('Move up')
          .setDisabled(index === 0)
          .onClick(async () => {
            this.move(this.plugin.settings.palette, index, index - 1);
            await this.plugin.saveSettings();
            this.display();
          })
      );

      row.addExtraButton((btn) =>
        btn
          .setIcon('arrow-down')
          .setTooltip('Move down')
          .setDisabled(index === palette.length - 1)
          .onClick(async () => {
            this.move(this.plugin.settings.palette, index, index + 1);
            await this.plugin.saveSettings();
            this.display();
          })
      );

      row.addExtraButton((btn) =>
        btn
          .setIcon('trash')
          .setTooltip('Remove color')
          .onClick(async () => {
            this.plugin.settings.palette.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          })
      );
    });

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('Add color')
        .setCta()
        .onClick(async () => {
          this.plugin.settings.palette.push('#ffffff');
          await this.plugin.saveSettings();
          this.display();
        })
    );
  }

  renderRestartFolders(containerEl) {
    new Setting(containerEl).setName('Restart folders').setHeading();

    const desc = containerEl.createEl('p', {
      text:
        'At these folders the rotation restarts: their direct subfolders begin ' +
        'a fresh pass through the palette, while notes directly inside keep the ' +
        "folder's own color.",
      cls: 'setting-item-description folder-themer-note',
    });
    const selected = this.plugin.settings.restartFolders;

    // All vault folders not already selected, for the add dropdown.
    const allFolders = this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && f.path !== '/')
      .map((f) => f.path)
      .filter((p) => !selected.includes(p))
      .sort((a, b) => a.localeCompare(b));

    const addRow = new Setting(containerEl)
      .setName('Add a restart folder')
      .setDesc('Pick an existing folder, then click Add.');

    let pending = allFolders[0] || '';
    addRow.addDropdown((dd) => {
      if (allFolders.length === 0) {
        dd.addOption('', 'No more folders available');
        dd.setDisabled(true);
      } else {
        for (const path of allFolders) dd.addOption(path, path);
        dd.setValue(pending);
      }
      dd.onChange((v) => (pending = v));
    });
    addRow.addButton((btn) =>
      btn
        .setButtonText('Add')
        .setDisabled(allFolders.length === 0)
        .onClick(async () => {
          if (!pending) return;
          this.plugin.settings.restartFolders.push(pending);
          await this.plugin.saveSettings();
          this.display();
        })
    );

    if (selected.length === 0) {
      const none = containerEl.createEl('p', {
        text: 'No restart folders yet.',
        cls: 'setting-item-description folder-themer-note',
      });
    }

    selected.forEach((path, index) => {
      new Setting(containerEl).setName(path).addExtraButton((btn) =>
        btn
          .setIcon('trash')
          .setTooltip('Remove')
          .onClick(async () => {
            this.plugin.settings.restartFolders.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          })
      );
    });
  }

  renderAppTheme(containerEl) {
    new Setting(containerEl).setName('App theme').setHeading();

    const desc = containerEl.createEl('p', {
      text:
        'Spread the palette across the whole interface. The first color drives ' +
        "Obsidian's accent (links, buttons, toggles, selection); other colors " +
        'are used for headings, tags and callouts. Backgrounds are left ' +
        'untouched, and the theme follows your light/dark toggle.',
      cls: 'setting-item-description folder-themer-note',
    });
    new Setting(containerEl)
      .setName('Apply app theme')
      .setDesc('Master switch for the palette-driven app theme.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.applyAppTheme).onChange(async (v) => {
          this.plugin.settings.applyAppTheme = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Color headings')
      .setDesc('Cycle H1–H6 through the palette.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.themeColorHeadings).onChange(async (v) => {
          this.plugin.settings.themeColorHeadings = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Color tags & callouts')
      .setDesc('Tint tags, highlights, and blockquote/callout borders.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.themeColorTags).onChange(async (v) => {
          this.plugin.settings.themeColorTags = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Tint app chrome')
      .setDesc(
        'Wash the sidebars, title bar, status bar, and ribbon with the first ' +
          'palette color. The editor/note background stays neutral.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.tintChrome).onChange(async (v) => {
          this.plugin.settings.tintChrome = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Chrome tint strength')
      .setDesc('How strongly the chrome is washed with color (0 = none).')
      .addSlider((s) =>
        s
          .setLimits(0, 40, 1)
          .setValue(this.plugin.settings.chromeTintStrength)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.chromeTintStrength = v;
            await this.plugin.saveSettings();
          })
      );
  }

  move(arr, from, to) {
    if (to < 0 || to >= arr.length) return;
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
  }
}

module.exports = FolderThemerPlugin;
