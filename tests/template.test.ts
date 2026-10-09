import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTemplate, propertyText, resolveTemplate, sanitizePath, sanitizeSegment, stripLinks, templateProblem } from '../src/template.ts';
import type { TemplateContext } from '../src/template.ts';
import { matchedTag, normalizeFolder, plan, planBatch, resolveDestination, ruleProblem, skipText } from '../src/rules.ts';
import type { NoteInfo, Rule } from '../src/rules.ts';

// A stand-in for moment: formats only YYYY, MM and DD of a date.
const formatDate = (input: string | number, format: string): string | null => {
  const d = typeof input === 'number' ? new Date(input) : /^\d{4}-\d{2}-\d{2}/.test(input) ? new Date(input.slice(0, 10) + 'T00:00:00Z') : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return format
    .replace('YYYY', String(d.getUTCFullYear()))
    .replace('MM', String(d.getUTCMonth() + 1).padStart(2, '0'))
    .replace('DD', String(d.getUTCDate()).padStart(2, '0'));
};
const CTIME = Date.UTC(2025, 2, 7, 12);
const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  title: 'My note',
  parent: 'Inbox',
  tag: null,
  properties: {},
  ctime: CTIME,
  dateProperty: '',
  formatDate,
  ...over,
});
const res = (src: string, over: Partial<TemplateContext> = {}) => resolveTemplate(src, ctx(over), normalizeFolder);

test('parses placeholders and text', () => {
  const p = parseTemplate('A/{{date:YYYY/MM}}/{{ Property : project }}/{{tag}}');
  assert.equal(p.error, null);
  assert.deepEqual(p.tokens.map((t) => t.kind), ['text', 'date', 'text', 'property', 'text', 'tag']);
  const prop = p.tokens[3];
  assert.ok(prop && prop.kind === 'property' && prop.name === 'project');
});

test('a date format may hold colons', () => {
  const t = parseTemplate('{{date:YYYY-MM-DD HH:mm}}').tokens[0];
  assert.ok(t && t.kind === 'date' && t.format === 'YYYY-MM-DD HH:mm');
});

test('broken templates are reported', () => {
  assert.ok(parseTemplate('A/{{date}}').error);
  assert.ok(parseTemplate('A/{{property:}}').error);
  assert.ok(parseTemplate('A/{{nope}}').error);
  assert.ok(parseTemplate('A/{{tag:x}}').error);
  assert.ok(parseTemplate('A/{{date:YYYY').error);
  assert.ok(parseTemplate('A/}}').error);
  assert.equal(templateProblem('A/{{date:YYYY/MM}}', normalizeFolder), null);
  assert.ok(templateProblem('../{{tag}}', normalizeFolder));
  assert.deepEqual(res('A/{{nope}}'), { invalid: 'Unknown placeholder {{nope}}. Use {{date:…}}, {{property:…}}, {{tag}}, {{title}} or {{parent}}.' });
});

test('sanitises folder names', () => {
  assert.equal(sanitizeSegment('a:b*c?d"e<f>g|h'), 'abcdefgh');
  assert.equal(sanitizeSegment('  ..hidden.. '), 'hidden');
  assert.equal(sanitizeSegment('a..b'), 'a.b');
  assert.equal(sanitizeSegment('..'), '');
  assert.equal(sanitizeSegment('a/b\\c'), 'a-b-c');
  assert.equal(sanitizeSegment('x'.repeat(300)).length, 100);
  assert.equal(sanitizePath('a//b/../c/ . /d'), 'a/b/c/d');
});

test('date from creation time', () => {
  assert.deepEqual(res('Journal/{{date:YYYY/MM}}'), { folder: 'Journal/2025/03' });
});

test('date from a property, falling back to creation time when it is missing or not a date', () => {
  const props = { created: '2024-12-31' };
  assert.deepEqual(res('J/{{date:YYYY/MM}}', { properties: props, dateProperty: 'created' }), { folder: 'J/2024/12' });
  assert.deepEqual(res('J/{{date:YYYY/MM}}', { properties: props, dateProperty: 'Created' }), { folder: 'J/2024/12' });
  assert.deepEqual(res('J/{{date:YYYY}}', { properties: { created: 'soon' }, dateProperty: 'created' }), { folder: 'J/2025' });
  assert.deepEqual(res('J/{{date:YYYY}}', { properties: {}, dateProperty: 'created' }), { folder: 'J/2025' });
  assert.deepEqual(res('J/{{date:YYYY}}', { properties: { created: ['2023-01-05', '2020-01-01'] }, dateProperty: 'created' }), { folder: 'J/2023' });
});

test('a date with no source is empty', () => {
  assert.deepEqual(res('J/{{date:YYYY}}', { ctime: 0 }), { empty: '{{date:YYYY}}' });
  assert.deepEqual(res('J/{{date:YYYY}}', { formatDate: undefined }), { empty: '{{date:YYYY}}' });
});

test('property: first item of a list, links without brackets', () => {
  assert.deepEqual(res('P/{{property:project}}', { properties: { project: 'Apollo' } }), { folder: 'P/Apollo' });
  assert.deepEqual(res('P/{{property:Project}}', { properties: { project: ['Apollo', 'Zeus'] } }), { folder: 'P/Apollo' });
  assert.deepEqual(res('P/{{property:project}}', { properties: { project: '[[Projects/Apollo]]' } }), { folder: 'P/Apollo' });
  assert.deepEqual(res('P/{{property:project}}', { properties: { project: ['[[Apollo|The Apollo]]'] } }), { folder: 'P/The Apollo' });
  assert.deepEqual(res('P/{{property:n}}', { properties: { n: 7 } }), { folder: 'P/7' });
  assert.equal(stripLinks('[[A#H]] and [[x/B]]'), 'A and B');
  assert.equal(propertyText(['', null, 'ok']), 'ok');
});

test('a value cannot climb out of the destination', () => {
  assert.deepEqual(res('P/{{property:p}}', { properties: { p: '../../etc' } }), { folder: 'P/-.-etc' });
  assert.deepEqual(res('P/{{property:p}}', { properties: { p: '..' } }), { empty: '{{property:p}}' });
  assert.deepEqual(res('P/{{property:p}}', { properties: { p: 'a/b' } }), { folder: 'P/a-b' });
});

test('empty placeholders skip', () => {
  assert.deepEqual(res('P/{{property:project}}', { properties: {} }), { empty: '{{property:project}}' });
  assert.deepEqual(res('P/{{property:project}}', { properties: { project: '' } }), { empty: '{{property:project}}' });
  assert.deepEqual(res('P/{{property:project}}', { properties: { project: [] } }), { empty: '{{property:project}}' });
  assert.deepEqual(res('P/{{property:project}}', { properties: { project: '???' } }), { empty: '{{property:project}}' });
  assert.deepEqual(res('P/{{tag}}'), { empty: '{{tag}}' });
  assert.deepEqual(res('P/{{parent}}', { parent: '' }), { empty: '{{parent}}' });
});

test('tag keeps nesting; title and parent', () => {
  assert.deepEqual(res('T/{{tag}}', { tag: 'project/alpha' }), { folder: 'T/project/alpha' });
  assert.deepEqual(res('{{parent}}/{{title}}', {}), { folder: 'Inbox/My note' });
  assert.deepEqual(res('A/{{title}}', { title: 'Q1: plan?' }), { folder: 'A/Q1 plan' });
});

test('matchedTag', () => {
  assert.equal(matchedTag(['#other', '#Project/Alpha'], 'project'), 'Project/Alpha');
  assert.equal(matchedTag(['projects'], 'project'), null);
});

const rule = (over: Partial<Rule>): Rule => ({ id: 'r', enabled: true, type: 'tag', property: '', value: 'project', destination: 'X', ...over });
const note = (path: string, over: Partial<NoteInfo> = {}): NoteInfo => ({ path, tags: [], properties: {}, ctime: CTIME, ...over });
const opts = { excluded: [], exists: () => false, formatDate };

test('plan moves into the resolved folder', () => {
  const p = plan(note('Inbox/a.md', { tags: ['#project/alpha'] }), [rule({ destination: '{{tag}}/{{date:YYYY}}' })], opts);
  assert.deepEqual(p.status === 'move' && p.to, 'project/alpha/2025/a.md');
});

test('plan: empty placeholder skips the note and later rules do not take it', () => {
  const rules = [rule({ type: 'property', property: 'type', value: '', destination: 'By/{{property:project}}' }), rule({ destination: 'Fallback' })];
  const n = note('Inbox/a.md', { tags: ['project'], properties: { type: 'x' } });
  const p = plan(n, rules, opts);
  assert.equal(p.status, 'skip');
  assert.equal(p.status === 'skip' && p.reason, 'empty');
  assert.equal(p.status === 'skip' && skipText(p.reason, p.detail), 'skipped: empty {{property:project}}');
});

test('plan: a note already in its resolved folder stays', () => {
  const p = plan(note('Journal/2025/03/a.md'), [rule({ type: 'path', value: 'a', destination: 'Journal/{{date:YYYY/MM}}' })], opts);
  assert.equal(p.status === 'skip' && p.reason, 'in-place');
});

test('plan: {{parent}} is stable after the move', () => {
  const r = rule({ type: 'path', value: 'a', destination: 'Sorted/{{parent}}' });
  const p = plan(note('Inbox/a.md'), [r], opts);
  assert.equal(p.status === 'move' && p.to, 'Sorted/Inbox/a.md');
});

test('planBatch: two notes of one name still conflict inside a template folder', () => {
  const rules = [rule({ destination: 'P/{{property:p}}' })];
  const plans = planBatch([note('A/n.md', { tags: ['project'], properties: { p: 'x' } }), note('B/n.md', { tags: ['project'], properties: { p: 'x' } })], rules, opts);
  assert.deepEqual(plans.map((x) => (x.status === 'move' ? 'move' : x.status === 'skip' ? x.reason : '')), ['move', 'conflict']);
});

test('ruleProblem understands templates', () => {
  assert.equal(ruleProblem(rule({ destination: 'J/{{date:YYYY-MM-DD HH:mm}}' })), null);
  assert.ok(ruleProblem(rule({ destination: 'J/{{date}}' })));
  assert.ok(ruleProblem(rule({ destination: '../{{tag}}' })));
  assert.deepEqual(resolveDestination(note('a.md'), rule({ destination: 'J/{{date:YYYY}}' }), formatDate), { folder: 'J/2025' });
});

test('plain destinations behave as before', () => {
  assert.deepEqual(resolveDestination(note('a.md'), rule({ destination: ' A//B/ ' })), { folder: 'A/B' });
});
