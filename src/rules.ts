// Pure logic: no `obsidian` import, so tests/ can run it under plain Node.

export type RuleType = 'tag' | 'property' | 'title' | 'path';

export interface Rule {
  id: string;
  enabled: boolean;
  type: RuleType;
  /** The property name, for `property` rules. */
  property: string;
  /**
   * `tag`: the tag, nested tags included. `property`: the value to find (empty: the property has any value).
   * `title` and `path`: a regular expression, case-insensitive.
   */
  value: string;
  /** Destination folder, vault-relative. Empty: the vault root. */
  destination: string;
}

export interface NoteInfo {
  /** Vault-relative path including the extension. */
  path: string;
  /** Tags from the body and the frontmatter, with or without the leading #. */
  tags: string[];
  /** Parsed frontmatter. */
  properties: Record<string, unknown>;
}

/** A note with this property set to one of the DISABLE_VALUES is never moved. */
export const DISABLE_PROPERTY = 'note-mover';
const DISABLE_VALUES = ['disable', 'disabled', 'off', 'false', 'no'];

export const RULE_LABELS: Record<RuleType, string> = {
  tag: 'Tag',
  property: 'Property',
  title: 'Title matches',
  path: 'Path matches',
};

export type SkipReason = 'excluded' | 'disabled' | 'no-rule' | 'in-place' | 'conflict' | 'unstable';

export type Plan =
  | { status: 'move'; from: string; to: string; rule: Rule }
  | { status: 'skip'; from: string; reason: SkipReason; rule?: Rule; to?: string };

export interface PlanOptions {
  /** Folders whose notes are never moved (the folder and everything inside it). */
  excluded: string[];
  /** Whether a file or folder already sits at this path. Compared by the caller case-insensitively. */
  exists: (path: string) => boolean;
}

/** A vault-relative folder path, cleaned up. `''` is the vault root. `null` when it cannot be a folder. */
export function normalizeFolder(input: string): string | null {
  const parts = input
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || /[:*?"<>|]/.test(p))) return null;
  return parts.join('/');
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, '').toLowerCase();
}

/** `#a` matches `#a` and `#a/b`, never `#ab`. */
export function tagMatches(noteTags: string[], ruleTag: string): boolean {
  const wanted = normalizeTag(ruleTag);
  if (!wanted) return false;
  return noteTags.some((t) => {
    const tag = normalizeTag(t);
    return tag === wanted || tag.startsWith(wanted + '/');
  });
}

export function compileRegex(source: string): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

function lookup(props: Record<string, unknown>, key: string): { found: boolean; value: unknown } {
  const wanted = key.trim().toLowerCase();
  for (const k of Object.keys(props)) {
    if (k.toLowerCase() === wanted) return { found: true, value: props[k] };
  }
  return { found: false, value: undefined };
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim().toLowerCase();
  return null;
}

/** Equal to the value, case-insensitively, or one item of a list. An empty value only asks that the property has something. */
export function propertyMatches(props: Record<string, unknown>, key: string, value: string): boolean {
  if (!key.trim()) return false;
  const { found, value: v } = lookup(props, key);
  if (!found || isEmpty(v)) return false;
  const wanted = value.trim().toLowerCase();
  if (wanted === '') return true;
  if (Array.isArray(v)) return (v as unknown[]).some((item) => scalar(item) === wanted);
  return scalar(v) === wanted;
}

export function isDisabled(props: Record<string, unknown>): boolean {
  const { found, value } = lookup(props, DISABLE_PROPERTY);
  if (!found) return false;
  const s = scalar(value);
  return s !== null && DISABLE_VALUES.includes(s);
}

/** What is wrong with a rule, for the settings tab. `null`: nothing. */
export function ruleProblem(rule: Rule): string | null {
  if (normalizeFolder(rule.destination) === null) return 'The destination is not a valid folder path.';
  switch (rule.type) {
    case 'tag':
      return normalizeTag(rule.value) ? null : 'Enter a tag.';
    case 'property':
      return rule.property.trim() ? null : 'Enter a property name.';
    case 'title':
    case 'path':
      if (!rule.value) return 'Enter a regular expression.';
      return compileRegex(rule.value) ? null : 'The regular expression is not valid.';
  }
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function basenameOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function ruleMatches(note: NoteInfo, rule: Rule): boolean {
  if (!rule.enabled || ruleProblem(rule)) return false;
  switch (rule.type) {
    case 'tag':
      return tagMatches(note.tags, rule.value);
    case 'property':
      return propertyMatches(note.properties, rule.property, rule.value);
    case 'title':
      return compileRegex(rule.value)?.test(basenameOf(note.path)) ?? false;
    case 'path':
      return compileRegex(rule.value)?.test(note.path) ?? false;
  }
}

/** The first enabled, valid rule that matches. Later rules never get a say. */
export function firstMatch(note: NoteInfo, rules: Rule[]): Rule | null {
  return rules.find((r) => ruleMatches(note, r)) ?? null;
}

/** Folder names compare ignoring case, as macOS and Windows file systems do. */
export function isExcluded(path: string, excluded: string[]): boolean {
  const folder = folderOf(path).toLowerCase();
  return excluded.some((raw) => {
    const e = normalizeFolder(raw)?.toLowerCase();
    if (!e) return false;
    return folder === e || folder.startsWith(e + '/');
  });
}

/** A note already inside the destination, in a subfolder too, stays where it is. */
export function inPlace(path: string, destination: string): boolean {
  const folder = folderOf(path);
  return destination === '' ? folder === '' : folder === destination || folder.startsWith(destination + '/');
}

export function plan(note: NoteInfo, rules: Rule[], opts: PlanOptions): Plan {
  const from = note.path;
  if (isExcluded(from, opts.excluded)) return { status: 'skip', from, reason: 'excluded' };
  if (isDisabled(note.properties)) return { status: 'skip', from, reason: 'disabled' };
  const rule = firstMatch(note, rules);
  if (!rule) return { status: 'skip', from, reason: 'no-rule' };
  const destination = normalizeFolder(rule.destination) ?? '';
  if (inPlace(from, destination)) return { status: 'skip', from, reason: 'in-place', rule };
  const to = destination ? `${destination}/${fileName(from)}` : fileName(from);
  if (opts.exists(to)) return { status: 'skip', from, reason: 'conflict', rule, to };
  // Rules that send a note back and forth (a path rule matching the new place, say) would
  // move it again after every move: leave it where it is.
  const next = firstMatch({ ...note, path: to }, rules);
  if (next && !inPlace(to, normalizeFolder(next.destination) ?? '')) return { status: 'skip', from, reason: 'unstable', rule, to };
  return { status: 'move', from, to, rule };
}

/**
 * Plans every note. Two notes of the same name heading for one folder: the first moves, the
 * second is a conflict, so the batch never overwrites or renames anything it did not announce.
 */
export function planBatch(notes: NoteInfo[], rules: Rule[], opts: PlanOptions): Plan[] {
  const taken = new Set<string>();
  const exists = (p: string) => taken.has(p.toLowerCase()) || opts.exists(p);
  return [...notes]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((note) => {
      const p = plan(note, rules, { ...opts, exists });
      if (p.status === 'move') taken.add(p.to.toLowerCase());
      return p;
    });
}

export interface Move {
  from: string;
  to: string;
}

export type UndoStep = { status: 'back'; from: string; to: string } | { status: 'missing' | 'occupied'; from: string; to: string };

/**
 * How to take a batch back, last move first. A note that is gone from where it was put, or
 * whose old place has been taken since, stays where it is.
 */
export function undoSteps(moves: Move[], exists: (path: string) => boolean): UndoStep[] {
  return [...moves].reverse().map((m) => {
    if (!exists(m.to)) return { status: 'missing', from: m.from, to: m.to };
    if (exists(m.from)) return { status: 'occupied', from: m.from, to: m.to };
    return { status: 'back', from: m.from, to: m.to };
  });
}

export const SKIP_TEXT: Record<SkipReason, string> = {
  excluded: 'in an excluded folder',
  disabled: `has ${DISABLE_PROPERTY}: disable`,
  'no-rule': 'matches no rule',
  'in-place': 'already in its folder',
  conflict: 'a note with that name is already there',
  unstable: 'another rule would move it again from its new folder',
};
