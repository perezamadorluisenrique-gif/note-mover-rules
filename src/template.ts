// Destination folders built from the note: `Journal/{{date:YYYY/MM}}`, `Projects/{{property:project}}`.
// Pure logic: the date formatter is passed in (the plugin gives it the app's `moment`).

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'date'; format: string; raw: string }
  | { kind: 'property'; name: string; raw: string }
  | { kind: 'tag'; raw: string }
  | { kind: 'title'; raw: string }
  | { kind: 'parent'; raw: string };

export interface ParsedTemplate {
  tokens: Token[];
  /** What is wrong with the template, or `null`. */
  error: string | null;
}

export interface TemplateContext {
  /** The note's name without the extension. */
  title: string;
  /** The name of the folder the note is in now; empty in the vault root. */
  parent: string;
  /** The tag that matched the rule (without `#`, nested tags with their `/`), or `null`. */
  tag: string | null;
  properties: Record<string, unknown>;
  /** Creation time in milliseconds. */
  ctime: number;
  /** The property to read the date from; empty or unusable: the creation time. */
  dateProperty: string;
  /** Formats a date with a moment format. `null`: the input is not a date. A string is the text of a property. */
  formatDate?: (input: string | number, format: string) => string | null;
}

export type Resolved = { folder: string } | { empty: string } | { invalid: string };

const MAX_SEGMENT = 100;

export function hasPlaceholders(src: string): boolean {
  return src.includes('{{');
}

export function parseTemplate(src: string): ParsedTemplate {
  const tokens: Token[] = [];
  const re = /\{\{([^{}]*)\}\}/g;
  let last = 0;
  let error: string | null = null;
  const text = (t: string) => {
    if (t === '') return;
    if (t.includes('{{') || t.includes('}}')) error ??= 'A {{ is not closed.';
    tokens.push({ kind: 'text', text: t });
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    text(src.slice(last, m.index));
    last = m.index + m[0].length;
    const raw = m[0];
    const inner = m[1] ?? '';
    const colon = inner.indexOf(':');
    const key = (colon < 0 ? inner : inner.slice(0, colon)).trim().toLowerCase();
    const arg = colon < 0 ? null : inner.slice(colon + 1).trim();
    if (key === 'date') {
      if (!arg) error ??= '{{date:…}} needs a format, for example {{date:YYYY/MM}}.';
      tokens.push({ kind: 'date', format: arg ?? '', raw });
    } else if (key === 'property') {
      if (!arg) error ??= '{{property:…}} needs a property name, for example {{property:project}}.';
      tokens.push({ kind: 'property', name: arg ?? '', raw });
    } else if ((key === 'tag' || key === 'title' || key === 'parent') && arg === null) {
      tokens.push({ kind: key, raw });
    } else {
      error ??= `Unknown placeholder ${raw}. Use {{date:…}}, {{property:…}}, {{tag}}, {{title}} or {{parent}}.`;
      tokens.push({ kind: 'text', text: '' });
    }
  }
  text(src.slice(last));
  return { tokens, error };
}

/** One folder name made safe: no `\ / : * ? " < > |`, no leading or trailing dots or spaces, no `..`. */
export function sanitizeSegment(input: string): string {
  let s = input
    .replace(/[\p{Cc}:*?"<>|]/gu, '')
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.');
  s = s.replace(/^[. ]+|[. ]+$/g, '');
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT).replace(/[. ]+$/g, '');
  return s;
}

/** A path made safe segment by segment. Empty segments go. */
export function sanitizePath(input: string): string {
  return input
    .split('/')
    .map(sanitizeSegment)
    .filter(Boolean)
    .join('/');
}

export function lookup(props: Record<string, unknown>, key: string): { found: boolean; value: unknown } {
  const wanted = key.trim().toLowerCase();
  for (const k of Object.keys(props)) {
    if (k.toLowerCase() === wanted) return { found: true, value: props[k] };
  }
  return { found: false, value: undefined };
}

/** `[[Folder/Note#Heading|Alias]]` becomes `Alias`, `[[Folder/Note]]` becomes `Note`. */
export function stripLinks(s: string): string {
  return s.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => {
    if (alias && alias.trim()) return alias.trim();
    const name = target.split('#')[0] ?? '';
    return name.slice(name.lastIndexOf('/') + 1).trim();
  });
}

/** The text of a property for a folder name: the first item of a list, links without brackets. Empty when there is none. */
export function propertyText(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      const t = propertyText(item);
      if (t) return t;
    }
    return '';
  }
  if (typeof value === 'string') return stripLinks(value).trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function resolveDate(format: string, ctx: TemplateContext): string {
  const fmt = ctx.formatDate;
  if (!fmt || !format) return '';
  if (ctx.dateProperty.trim()) {
    const raw = propertyText(lookup(ctx.properties, ctx.dateProperty).value);
    const out = raw ? fmt(raw, format) : null;
    if (out !== null) return out;
  }
  if (Number.isFinite(ctx.ctime) && ctx.ctime > 0) return fmt(ctx.ctime, format) ?? '';
  return '';
}

/** The static text of a template with every placeholder replaced by a stand-in, to check the folder path. */
export function templateProblem(src: string, normalize: (path: string) => string | null): string | null {
  const parsed = parseTemplate(src);
  if (parsed.error) return parsed.error;
  const stand = parsed.tokens.map((t) => (t.kind === 'text' ? t.text : 'x')).join('');
  return normalize(stand) === null ? 'The destination is not a valid folder path.' : null;
}

/**
 * The folder a template stands for, for one note. `empty` names the first placeholder that
 * came out empty (the rule is skipped for this note); `invalid` explains a broken template.
 */
export function resolveTemplate(src: string, ctx: TemplateContext, normalize: (path: string) => string | null): Resolved {
  const parsed = parseTemplate(src);
  if (parsed.error) return { invalid: parsed.error };
  let out = '';
  for (const t of parsed.tokens) {
    let part: string;
    switch (t.kind) {
      case 'text':
        out += t.text;
        continue;
      case 'date':
        part = sanitizePath(resolveDate(t.format, ctx));
        break;
      case 'property':
        part = sanitizeSegment(propertyText(lookup(ctx.properties, t.name).value));
        break;
      case 'tag':
        part = sanitizePath(ctx.tag ?? '');
        break;
      case 'title':
        part = sanitizeSegment(ctx.title);
        break;
      case 'parent':
        part = sanitizeSegment(ctx.parent);
        break;
    }
    if (!part) return { empty: t.raw };
    out += part;
  }
  const folder = normalize(out);
  return folder === null ? { invalid: 'The destination is not a valid folder path.' } : { folder };
}
