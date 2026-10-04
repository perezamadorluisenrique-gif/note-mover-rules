import type { SettingDefinitionItem } from 'obsidian';
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, getAllTags } from 'obsidian';

import {
  DISABLE_PROPERTY,
  RULE_LABELS,
  SKIP_TEXT,
  folderOf,
  normalizeFolder,
  plan,
  planBatch,
  ruleProblem,
  undoSteps,
} from './src/rules.ts';
import type { Move, NoteInfo, Plan, Rule, RuleType } from './src/rules.ts';

interface NoteMoverSettings {
  rules: Rule[];
  /** Folders whose notes are never moved, one per line in the settings tab. */
  excluded: string[];
  /** Move a note by itself when its tags, properties or name start to match a rule. */
  autoMove: boolean;
  /** Create the destination folder when it does not exist. */
  createFolders: boolean;
}

const DEFAULT_SETTINGS: NoteMoverSettings = {
  rules: [],
  excluded: [],
  autoMove: false,
  createFolders: true,
};

/** After a note changes, wait this long (ms) before moving it, so a half-typed tag does not send it away. */
const AUTO_DELAY_MS = 2000;

const RULE_TYPES: Record<RuleType, string> = RULE_LABELS;

function newRule(): Rule {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    enabled: true,
    type: 'tag',
    property: '',
    value: '',
    destination: '',
  };
}

function describeRule(rule: Rule): string {
  const dest = normalizeFolder(rule.destination) || '/';
  switch (rule.type) {
    case 'tag':
      return `#${rule.value.replace(/^#/, '')} → ${dest}`;
    case 'property':
      return `${rule.property}${rule.value ? ` = ${rule.value}` : ''} → ${dest}`;
    case 'title':
      return `title /${rule.value}/ → ${dest}`;
    case 'path':
      return `path /${rule.value}/ → ${dest}`;
  }
}

export default class NoteMoverRulesPlugin extends Plugin {
  settings: NoteMoverSettings = { ...DEFAULT_SETTINGS };
  /** The last batch that moved, for the undo command. */
  last: Move[] = [];
  private timers = new Map<TFile, number>();
  /** Paths this plugin is moving right now, so its own rename events do not start another pass. */
  private moving = new Set<string>();
  private warned = new Set<string>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NoteMoverSettingTab(this.app, this));

    this.addCommand({
      id: 'move-active',
      name: 'Move this note by the rules',
      icon: 'folder-input',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.moveNotes([file], true);
        return true;
      },
    });
    this.addCommand({
      id: 'move-folder',
      name: 'Preview moves for the notes in this folder',
      icon: 'folder-tree',
      checkCallback: (checking) => {
        const folder = this.app.workspace.getActiveFile()?.parent;
        if (!folder) return false;
        if (!checking) this.preview(folder);
        return true;
      },
    });
    this.addCommand({
      id: 'move-all',
      name: 'Preview moves for every note',
      icon: 'folders',
      callback: () => this.preview(this.app.vault.getRoot()),
    });
    this.addCommand({
      id: 'undo',
      name: 'Undo the last move',
      icon: 'undo-2',
      checkCallback: (checking) => {
        if (!this.last.length) return false;
        if (!checking) void this.undo();
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) => item.setTitle('Move notes by the rules').setIcon('folder-input').onClick(() => this.preview(file)));
      }),
    );

    // Vault events for every file arrive while the vault loads; register once the layout is ready.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.metadataCache.on('changed', (file) => this.schedule(file)));
      this.registerEvent(
        this.app.vault.on('rename', (file) => {
          if (file instanceof TFile && !this.moving.has(file.path)) this.schedule(file);
        }),
      );
    });
  }

  onunload() {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<NoteMoverSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
    if (!Array.isArray(this.settings.rules)) this.settings.rules = [];
    if (!Array.isArray(this.settings.excluded)) this.settings.excluded = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  noteInfo(file: TFile): NoteInfo {
    const cache = this.app.metadataCache.getFileCache(file);
    const properties = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    return { path: file.path, tags: (cache ? getAllTags(cache) : null) ?? [], properties };
  }

  /** Every path in the vault, lowercased: a move onto `a.md` also collides with `A.md` on case-insensitive file systems. */
  private pathSet(): Set<string> {
    return new Set(this.app.vault.getAllLoadedFiles().map((f) => f.path.toLowerCase()));
  }

  private planFor(files: TFile[]): Plan[] {
    const taken = this.pathSet();
    return planBatch(
      files.map((f) => this.noteInfo(f)),
      this.settings.rules,
      { excluded: this.settings.excluded, exists: (p) => taken.has(p.toLowerCase()) },
    );
  }

  private notesIn(folder: TFolder): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => (folder.isRoot() ? true : f.path.startsWith(folder.path + '/')));
  }

  /** Opens the preview for every note in the folder. */
  preview(folder: TFolder) {
    if (!this.settings.rules.length) {
      new Notice('Add a rule in the settings first.');
      return;
    }
    const plans = this.planFor(this.notesIn(folder));
    const moves = plans.filter((p): p is Extract<Plan, { status: 'move' }> => p.status === 'move');
    const conflicts = plans.filter((p): p is Extract<Plan, { status: 'skip' }> => p.status === 'skip' && p.reason === 'conflict');
    if (!moves.length && !conflicts.length) {
      new Notice('No notes to move: none matches a rule outside its folder.');
      return;
    }
    new PreviewModal(this.app, moves, conflicts, this.settings.createFolders, (chosen) => void this.run(chosen)).open();
  }

  /** Moves the given notes now, with a notice. `explain` also reports why a note stays. */
  async moveNotes(files: TFile[], explain: boolean) {
    const [p] = this.planFor(files);
    if (!p) return;
    if (p.status === 'move') {
      await this.run([p]);
    } else if (explain) {
      new Notice(`“${files[0]?.basename ?? ''}” stays: ${SKIP_TEXT[p.reason]}.`);
    }
  }

  /** Moves each planned note with `renameFile`, so links to it update, and remembers the batch. */
  async run(plans: Plan[]): Promise<Move[]> {
    const done: Move[] = [];
    const problems: string[] = [];
    for (const p of plans) {
      if (p.status !== 'move') continue;
      const file = this.app.vault.getFileByPath(p.from);
      if (!file) continue;
      if (this.app.vault.getAbstractFileByPath(p.to)) {
        problems.push(`“${file.basename}”: a note with that name is already in ${folderOf(p.to) || 'the vault root'}.`);
        continue;
      }
      try {
        if (!(await this.ensureFolder(folderOf(p.to)))) {
          problems.push(`“${file.basename}”: the folder ${folderOf(p.to)} does not exist.`);
          continue;
        }
        this.moving.add(p.to);
        await this.app.fileManager.renameFile(file, p.to);
        done.push({ from: p.from, to: p.to });
      } catch (e) {
        problems.push(`“${file.basename}”: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.moving.delete(p.to);
      }
    }
    if (done.length) this.last = done;
    this.report(done, problems);
    return done;
  }

  private report(done: Move[], problems: string[]) {
    const parts: string[] = [];
    if (done.length === 1 && done[0]) parts.push(`Moved “${done[0].to.slice(done[0].to.lastIndexOf('/') + 1)}” to ${folderOf(done[0].to) || 'the vault root'}.`);
    else if (done.length) parts.push(`Moved ${done.length} notes. Run “Undo the last move” to put them back.`);
    if (problems.length) parts.push(`${problems.length} not moved:\n${problems.slice(0, 5).join('\n')}${problems.length > 5 ? '\n…' : ''}`);
    if (parts.length) new Notice(parts.join('\n'), problems.length ? 8000 : 5000);
  }

  private async ensureFolder(folder: string): Promise<boolean> {
    if (!folder) return true;
    if (this.app.vault.getFolderByPath(folder)) return true;
    if (!this.settings.createFolders) return false;
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // Created meanwhile, or the name is taken by a file.
    }
    return Boolean(this.app.vault.getFolderByPath(folder));
  }

  async undo() {
    const paths = this.pathSet();
    const steps = undoSteps(this.last, (p) => paths.has(p.toLowerCase()));
    let back = 0;
    let stayed = 0;
    for (const s of steps) {
      const file = s.status === 'back' ? this.app.vault.getFileByPath(s.to) : null;
      if (!file || !(await this.ensureFolder(folderOf(s.from)))) {
        stayed++;
        continue;
      }
      this.moving.add(s.from);
      try {
        await this.app.fileManager.renameFile(file, s.from);
        back++;
      } catch {
        stayed++;
      } finally {
        this.moving.delete(s.from);
      }
    }
    this.last = [];
    new Notice(`Put ${back} ${back === 1 ? 'note' : 'notes'} back.${stayed ? ` ${stayed} could not go back: moved or replaced since.` : ''}`);
  }

  /** Waits for the note to settle, then moves it if a rule says so. */
  private schedule(file: TAbstractFile) {
    if (!this.settings.autoMove || !(file instanceof TFile) || file.extension !== 'md') return;
    if (this.moving.has(file.path)) return;
    const old = this.timers.get(file);
    if (old !== undefined) window.clearTimeout(old);
    this.timers.set(
      file,
      window.setTimeout(() => {
        this.timers.delete(file);
        void this.auto(file);
      }, AUTO_DELAY_MS),
    );
  }

  private async auto(file: TFile) {
    if (!this.settings.autoMove || !this.app.vault.getFileByPath(file.path)) return;
    const taken = this.pathSet();
    const p = plan(this.noteInfo(file), this.settings.rules, { excluded: this.settings.excluded, exists: (x) => taken.has(x.toLowerCase()) });
    if (p.status === 'move') {
      await this.run([p]);
    } else if (p.reason === 'conflict' && p.to) {
      const key = `${p.from}|${p.to}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        new Notice(`“${file.basename}” was not moved: ${SKIP_TEXT.conflict} in ${folderOf(p.to) || 'the vault root'}.`);
      }
    }
  }
}

/** The moves about to happen, each with a checkbox. Nothing moves until the button is pressed. */
class PreviewModal extends Modal {
  private chosen: Set<string>;

  constructor(
    app: App,
    private moves: Extract<Plan, { status: 'move' }>[],
    private conflicts: Extract<Plan, { status: 'skip' }>[],
    private createFolders: boolean,
    private onConfirm: (chosen: Plan[]) => void,
  ) {
    super(app);
    this.chosen = new Set(moves.map((m) => m.from));
  }

  onOpen() {
    this.modalEl.addClass('note-mover-rules-modal');
    this.setTitle('Move notes by the rules');
    this.draw();
  }

  private draw() {
    const { contentEl } = this;
    contentEl.empty();
    const known = new Set(this.app.vault.getAllFolders(true).map((f) => f.path));
    const list = contentEl.createDiv({ cls: 'note-mover-rules-list' });
    for (const m of this.moves) {
      const row = list.createEl('label', { cls: 'note-mover-rules-row' });
      const box = row.createEl('input', { type: 'checkbox' });
      box.checked = this.chosen.has(m.from);
      box.addEventListener('change', () => {
        if (box.checked) this.chosen.add(m.from);
        else this.chosen.delete(m.from);
        this.refresh();
      });
      const text = row.createDiv({ cls: 'note-mover-rules-text' });
      text.createDiv({ text: m.from, cls: 'note-mover-rules-from' });
      const folder = folderOf(m.to);
      const isNew = folder !== '' && !known.has(folder);
      text.createDiv({ text: `→ ${folder || 'vault root'}${isNew ? (this.createFolders ? ' (new folder)' : ' (folder missing: will not move)') : ''}`, cls: 'note-mover-rules-to' });
    }
    if (this.conflicts.length) {
      contentEl.createEl('h4', { text: `Will stay: a note with that name is already there (${this.conflicts.length})` });
      const stay = contentEl.createEl('ul', { cls: 'note-mover-rules-stay' });
      for (const c of this.conflicts) stay.createEl('li', { text: `${c.from} → ${c.to ?? ''}` });
    }
    contentEl.createEl('p', {
      text: 'Links to moved notes are updated. If Obsidian asks, choose “Always update” so it does not ask for each note.',
      cls: 'setting-item-description',
    });
    const footer = contentEl.createDiv({ cls: 'modal-button-container' });
    const all = footer.createEl('button', { text: 'Select all' });
    all.addEventListener('click', () => {
      this.chosen = new Set(this.moves.map((m) => m.from));
      this.draw();
    });
    const none = footer.createEl('button', { text: 'Select none' });
    none.addEventListener('click', () => {
      this.chosen.clear();
      this.draw();
    });
    this.go = footer.createEl('button', { cls: 'mod-cta' });
    this.go.addEventListener('click', () => {
      const chosen = this.moves.filter((m) => this.chosen.has(m.from));
      this.close();
      if (chosen.length) this.onConfirm(chosen);
    });
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    this.refresh();
  }

  private go: HTMLButtonElement | null = null;

  private refresh() {
    if (!this.go) return;
    const n = this.chosen.size;
    this.go.setText(`Move ${n} ${n === 1 ? 'note' : 'notes'}`);
    this.go.disabled = n === 0;
  }

  onClose() {
    this.contentEl.empty();
  }
}

const TEXT = {
  autoMove: {
    name: 'Move notes by themselves',
    desc: 'When a note is edited or renamed and now matches a rule, move it two seconds later. Off: notes move only with the commands. The undo command takes it back.',
  },
  createFolders: {
    name: 'Create missing folders',
    desc: 'When a destination folder does not exist, create it. Off: the note stays and you are told.',
  },
  excluded: { name: 'Never move notes in these folders', desc: 'One folder per line. Subfolders are included.' },
  rules: {
    name: 'Rules',
    desc: `A note goes to the folder of the first rule that matches it, checked from the top. A note already inside that folder stays. A note with ${DISABLE_PROPERTY}: disable in its properties is never moved. Titles and paths use regular expressions, ignoring case.`,
  },
};

class NoteMoverSettingTab extends PluginSettingTab {
  private legacy = false;

  constructor(
    app: App,
    private plugin: NoteMoverRulesPlugin,
  ) {
    super(app, plugin);
  }

  /** The settings, described rather than drawn: Obsidian 1.13 and later renders and searches them. Older versions call `display()`. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const d = DEFAULT_SETTINGS;
    return [
      {
        type: 'list',
        heading: TEXT.rules.name,
        emptyState: 'No rules yet. Press + to add one.',
        items: s.rules.map((rule, i) => ({
          name: `Rule ${i + 1}`,
          render: (setting: Setting) => this.drawRule(setting, rule, i),
        })),
        addItem: { name: 'Add rule', action: () => void this.addRule() },
        onDelete: (i: number) => void this.removeRule(i),
        onReorder: (from: number, to: number) => void this.reorder(from, to),
      },
      {
        type: 'group',
        heading: 'Moving',
        items: [
          { ...TEXT.autoMove, control: { type: 'toggle', key: 'autoMove', defaultValue: d.autoMove } },
          { ...TEXT.createFolders, control: { type: 'toggle', key: 'createFolders', defaultValue: d.createFolders } },
          { ...TEXT.excluded, control: { type: 'textarea', key: 'excluded', rows: 3, placeholder: 'Templates', defaultValue: '' } },
        ],
      },
    ];
  }

  /** The excluded folders are stored as an array but edited as text. */
  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    if (key === 'excluded') return s.excluded.join('\n');
    return (s as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    if (key === 'excluded') {
      s.excluded = String(value)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } else Object.assign(s, { [key]: value });
    await this.plugin.saveSettings();
  }

  /** Redraws after rules were added, removed or reordered. */
  private redraw() {
    if (this.legacy) {
      this.display();
      return;
    }
    // Obsidian 1.13's re-render of the declarative definitions, looked up because older versions lack it.
    (this as unknown as { update?: () => void }).update?.();
  }

  private async addRule() {
    this.plugin.settings.rules.push(newRule());
    await this.plugin.saveSettings();
    this.redraw();
  }

  private async removeRule(index: number) {
    this.plugin.settings.rules.splice(index, 1);
    await this.plugin.saveSettings();
    this.redraw();
  }

  private async reorder(from: number, to: number) {
    const rules = this.plugin.settings.rules;
    const [moved] = rules.splice(from, 1);
    if (moved) rules.splice(to, 0, moved);
    await this.plugin.saveSettings();
    this.redraw();
  }

  /** The pre-1.13 rendering. Obsidian skips it once `getSettingDefinitions()` returns anything. */
  display(): void {
    this.legacy = true;
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName(TEXT.rules.name).setDesc(TEXT.rules.desc).setHeading();
    s.rules.forEach((rule, i) => {
      const setting = new Setting(containerEl);
      this.drawRule(setting, rule, i);
      this.legacyButtons(setting, i);
    });
    new Setting(containerEl).addButton((b) => b.setButtonText('Add rule').setCta().onClick(() => void this.addRule()));

    new Setting(containerEl).setName('Moving').setHeading();
    new Setting(containerEl)
      .setName(TEXT.autoMove.name)
      .setDesc(TEXT.autoMove.desc)
      .addToggle((t) => t.setValue(s.autoMove).onChange((v) => this.setControlValue('autoMove', v)));
    new Setting(containerEl)
      .setName(TEXT.createFolders.name)
      .setDesc(TEXT.createFolders.desc)
      .addToggle((t) => t.setValue(s.createFolders).onChange((v) => this.setControlValue('createFolders', v)));
    new Setting(containerEl)
      .setName(TEXT.excluded.name)
      .setDesc(TEXT.excluded.desc)
      .addTextArea((t) => {
        t.setPlaceholder('Templates')
          .setValue(String(this.getControlValue('excluded')))
          .onChange((v) => this.setControlValue('excluded', v));
        t.inputEl.rows = 3;
      });
  }

  /** Up, down and delete, which the declarative list draws itself. */
  private legacyButtons(setting: Setting, index: number) {
    const last = this.plugin.settings.rules.length - 1;
    setting.addExtraButton((b) =>
      b
        .setIcon('arrow-up')
        .setTooltip('Move up')
        .setDisabled(index === 0)
        .onClick(() => void this.reorder(index, index - 1)),
    );
    setting.addExtraButton((b) =>
      b
        .setIcon('arrow-down')
        .setTooltip('Move down')
        .setDisabled(index === last)
        .onClick(() => void this.reorder(index, index + 1)),
    );
    setting.addExtraButton((b) =>
      b
        .setIcon('trash')
        .setTooltip('Delete rule')
        .onClick(() => void this.removeRule(index)),
    );
  }

  private drawRule(setting: Setting, rule: Rule, index: number) {
    const save = () => this.plugin.saveSettings();
    setting.setName(`Rule ${index + 1}`);
    setting.settingEl.addClass('note-mover-rules-rule');
    const show = () => {
      const problem = ruleProblem(rule);
      setting.setDesc(problem ?? describeRule(rule));
      setting.descEl.toggleClass('note-mover-rules-problem', Boolean(problem));
    };
    setting.addToggle((t) =>
      t.setValue(rule.enabled).onChange(async (v) => {
        rule.enabled = v;
        await save();
      }),
    );
    setting.addDropdown((d) =>
      d
        .addOptions(RULE_TYPES)
        .setValue(rule.type)
        .onChange(async (v) => {
          rule.type = v as RuleType;
          await save();
          this.redraw();
        }),
    );
    if (rule.type === 'property') {
      setting.addText((t) => {
        t.setPlaceholder('Property')
          .setValue(rule.property)
          .onChange(async (v) => {
            rule.property = v;
            show();
            await save();
          });
        t.inputEl.addClass('note-mover-rules-input');
      });
    }
    setting.addText((t) => {
      t.setPlaceholder(rule.type === 'tag' ? '#project' : rule.type === 'property' ? 'Value (any)' : '^\\d{4}-\\d{2}-\\d{2}')
        .setValue(rule.value)
        .onChange(async (v) => {
          rule.value = v;
          show();
          await save();
        });
      t.inputEl.addClass('note-mover-rules-input');
    });
    setting.addText((t) => {
      t.setPlaceholder('Folder')
        .setValue(rule.destination)
        .onChange(async (v) => {
          rule.destination = v;
          show();
          await save();
        });
      t.inputEl.addClass('note-mover-rules-input');
    });
    show();
  }
}
