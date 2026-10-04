import test from 'node:test';
import assert from 'node:assert/strict';

import {
  firstMatch,
  isDisabled,
  isExcluded,
  normalizeFolder,
  plan,
  planBatch,
  propertyMatches,
  ruleMatches,
  ruleProblem,
  tagMatches,
  undoSteps,
} from '../src/rules.ts';
import type { NoteInfo, Rule } from '../src/rules.ts';

let n = 0;
const rule = (over: Partial<Rule>): Rule => ({
  id: `r${n++}`,
  enabled: true,
  type: 'tag',
  property: '',
  value: '',
  destination: 'Dest',
  ...over,
});
const note = (path: string, over: Partial<NoteInfo> = {}): NoteInfo => ({ path, tags: [], properties: {}, ...over });
const none = { excluded: [], exists: () => false };

test('normalizeFolder cleans paths and refuses escapes', () => {
  assert.equal(normalizeFolder(' /Projects//Active/ '), 'Projects/Active');
  assert.equal(normalizeFolder('a\\b'), 'a/b');
  assert.equal(normalizeFolder('/'), '');
  assert.equal(normalizeFolder(''), '');
  assert.equal(normalizeFolder('../x'), null);
  assert.equal(normalizeFolder('a/../b'), null);
  assert.equal(normalizeFolder('a:b'), null);
});

test('tags match nested tags but not longer names', () => {
  assert.equal(tagMatches(['#food'], 'food'), true);
  assert.equal(tagMatches(['food'], '#Food'), true);
  assert.equal(tagMatches(['#food/pasta'], '#food'), true);
  assert.equal(tagMatches(['#foodie'], '#food'), false);
  assert.equal(tagMatches(['#food'], '#food/pasta'), false);
  assert.equal(tagMatches(['#food'], ''), false);
});

test('property rules: value, list item, any value, case, missing', () => {
  assert.equal(propertyMatches({ Status: 'Done' }, 'status', 'done'), true);
  assert.equal(propertyMatches({ status: 'todo' }, 'status', 'done'), false);
  assert.equal(propertyMatches({ type: ['a', 'Book'] }, 'type', 'book'), true);
  assert.equal(propertyMatches({ type: ['a'] }, 'type', 'book'), false);
  assert.equal(propertyMatches({ done: true }, 'done', 'true'), true);
  assert.equal(propertyMatches({ rating: 5 }, 'rating', '5'), true);
  assert.equal(propertyMatches({ status: 'x' }, 'status', ''), true);
  assert.equal(propertyMatches({ status: '' }, 'status', ''), false);
  assert.equal(propertyMatches({ status: null }, 'status', ''), false);
  assert.equal(propertyMatches({ status: [] }, 'status', ''), false);
  assert.equal(propertyMatches({}, 'status', ''), false);
  assert.equal(propertyMatches({ status: 'x' }, '', 'x'), false);
});

test('title and path rules use case-insensitive regular expressions', () => {
  const t = rule({ type: 'title', value: '^\\d{4}-\\d{2}-\\d{2}$' });
  assert.equal(ruleMatches(note('Inbox/2026-10-04.md'), t), true);
  assert.equal(ruleMatches(note('Inbox/2026-10-04 notes.md'), t), false);
  assert.equal(ruleMatches(note('Inbox/Meeting.md'), rule({ type: 'title', value: 'MEETING' })), true);
  assert.equal(ruleMatches(note('a/b/c.md'), rule({ type: 'path', value: '^[^/]+\\.md$' })), false);
  assert.equal(ruleMatches(note('c.md'), rule({ type: 'path', value: '^[^/]+\\.md$' })), true);
});

test('invalid or disabled rules never match and say why', () => {
  const bad = rule({ type: 'title', value: '(' });
  assert.equal(ruleProblem(bad), 'The regular expression is not valid.');
  assert.equal(ruleMatches(note('a.md'), bad), false);
  assert.equal(ruleMatches(note('a.md', { tags: ['t'] }), rule({ value: 't', enabled: false })), false);
  assert.equal(ruleMatches(note('a.md', { tags: ['t'] }), rule({ value: 't', destination: '../x' })), false);
  assert.equal(ruleProblem(rule({ type: 'property', value: 'x' })), 'Enter a property name.');
  assert.equal(ruleProblem(rule({ value: '' })), 'Enter a tag.');
  assert.equal(ruleProblem(rule({ value: 't' })), null);
});

test('the first matching rule wins', () => {
  const a = rule({ value: 'a', destination: 'A' });
  const b = rule({ value: 'b', destination: 'B' });
  assert.equal(firstMatch(note('x.md', { tags: ['b', 'a'] }), [a, b]), a);
  assert.equal(firstMatch(note('x.md', { tags: ['b'] }), [a, b]), b);
  assert.equal(firstMatch(note('x.md'), [a, b]), null);
});

test('plan: move, nothing to do, conflict', () => {
  const r = rule({ value: 'food', destination: 'Recipes' });
  const food = note('Inbox/Pasta.md', { tags: ['#food'] });
  assert.deepEqual(plan(food, [r], none), { status: 'move', from: 'Inbox/Pasta.md', to: 'Recipes/Pasta.md', rule: r });
  assert.equal(plan(note('Recipes/Pasta.md', { tags: ['food'] }), [r], none).status, 'skip');
  assert.equal((plan(note('Recipes/Soup/Pasta.md', { tags: ['food'] }), [r], none) as { reason: string }).reason, 'in-place');
  assert.equal((plan(note('Inbox/Pasta.md'), [r], none) as { reason: string }).reason, 'no-rule');
  const c = plan(food, [r], { excluded: [], exists: (p) => p === 'Recipes/Pasta.md' });
  assert.equal(c.status === 'skip' && c.reason, 'conflict');
  assert.equal(c.status === 'skip' && c.to, 'Recipes/Pasta.md');
});

test('plan: a rule whose folder is the note\'s own stops later rules', () => {
  const first = rule({ value: 'a', destination: 'A' });
  const second = rule({ value: 'b', destination: 'B' });
  const p = plan(note('A/x.md', { tags: ['a', 'b'] }), [first, second], none);
  assert.equal(p.status === 'skip' && p.reason, 'in-place');
});

test('plan: rules that would bounce a note are left alone', () => {
  const toA = rule({ type: 'path', value: '^B/', destination: 'A' });
  const toB = rule({ value: 'x', destination: 'B' });
  const p = plan(note('B/n.md', { tags: ['x'] }), [toA, toB], none);
  assert.equal(p.status === 'skip' && p.reason, 'unstable');
  assert.equal(p.status === 'skip' && p.to, 'A/n.md');
  // From the inbox it would land in B and then be sent on to A: also left alone.
  assert.equal(plan(note('Inbox/n.md', { tags: ['x'] }), [toA, toB], none).status, 'skip');
  // A note the loop does not reach still moves.
  assert.equal(plan(note('Inbox/m.md', { tags: ['x'] }), [toB], none).status, 'move');
});

test('plan: root destination', () => {
  const r = rule({ value: 'top', destination: '/' });
  assert.equal(plan(note('Inbox/x.md', { tags: ['top'] }), [r], none).status, 'move');
  assert.deepEqual((plan(note('Inbox/x.md', { tags: ['top'] }), [r], none) as { to: string }).to, 'x.md');
  assert.equal(plan(note('x.md', { tags: ['top'] }), [r], none).status, 'skip');
});

test('excluded folders and the disable property', () => {
  const r = rule({ value: 't' });
  assert.equal(isExcluded('Templates/a.md', ['Templates']), true);
  assert.equal(isExcluded('Templates/sub/a.md', ['/Templates/']), true);
  assert.equal(isExcluded('TemplatesX/a.md', ['Templates']), false);
  assert.equal(isExcluded('a.md', ['']), false);
  assert.equal(isExcluded('templates/a.md', ['Templates']), true);
  const ex = plan(note('Templates/a.md', { tags: ['t'] }), [r], { ...none, excluded: ['Templates'] });
  assert.equal(ex.status === 'skip' && ex.reason, 'excluded');
  assert.equal(isDisabled({ 'note-mover': 'disable' }), true);
  assert.equal(isDisabled({ 'Note-Mover': false }), true);
  assert.equal(isDisabled({ 'note-mover': 'enable' }), false);
  assert.equal(isDisabled({}), false);
  const d = plan(note('a.md', { tags: ['t'], properties: { 'note-mover': 'disable' } }), [r], none);
  assert.equal(d.status === 'skip' && d.reason, 'disabled');
});

test('planBatch never lets two notes land on one path, case-insensitively', () => {
  const r = rule({ value: 't', destination: 'Dest' });
  const plans = planBatch(
    [note('b/Same.md', { tags: ['t'] }), note('a/same.md', { tags: ['t'] }), note('c/Other.md', { tags: ['t'] })],
    [r],
    none,
  );
  assert.deepEqual(
    plans.map((p) => [p.from, p.status, p.status === 'skip' ? p.reason : p.to]),
    [
      ['a/same.md', 'move', 'Dest/same.md'],
      ['b/Same.md', 'skip', 'conflict'],
      ['c/Other.md', 'move', 'Dest/Other.md'],
    ],
  );
});

test('undoSteps goes backwards and refuses when places changed', () => {
  const moves = [
    { from: 'a/1.md', to: 'D/1.md' },
    { from: 'a/2.md', to: 'D/2.md' },
    { from: 'a/3.md', to: 'D/3.md' },
  ];
  const present = new Set(['D/1.md', 'D/2.md', 'a/3.md']);
  const steps = undoSteps(moves, (p) => present.has(p));
  assert.deepEqual(
    steps.map((s) => [s.from, s.status]),
    [
      ['a/3.md', 'missing'],
      ['a/2.md', 'back'],
      ['a/1.md', 'back'],
    ],
  );
  const occupied = undoSteps([{ from: 'a/1.md', to: 'D/1.md' }], () => true);
  assert.equal(occupied[0].status, 'occupied');
});
