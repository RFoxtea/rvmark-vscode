// Run with: node test.js
// Uses Node built-in test runner (node >= 18)
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Mock vscode ───────────────────────────────────────────────────────────────
class Range {
  constructor(startLine, startChar, endLine, endChar) {
    this.start = { line: startLine, character: startChar };
    this.end   = { line: endLine,   character: endChar };
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    this.range = range; this.message = message; this.severity = severity;
  }
}
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

const Module = require('module');
const _resolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  if (request === 'vscode') return 'vscode';
  return _resolveFilename(request, ...args);
};
require.cache['vscode'] = {
  id: 'vscode', filename: 'vscode', loaded: true,
  exports: { Range, Diagnostic, DiagnosticSeverity },
};

const { lintDocument, collectNodes, renumberAfterEdit, nextSiblingOrdinal, nextSiblingMarker } = require('./extension.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeDoc(text, languageId = 'rvmark') {
  const lines = text.split('\n');
  return {
    languageId,
    lineCount: lines.length,
    lineAt: i => ({ text: lines[i] }),
    uri: { fsPath: '/fake/test.rvmark' },
  };
}

// ── Mock editor for renumberAfterEdit ─────────────────────────────────────────
// renumberAfterEdit calls editor.edit() which our mock resolves synchronously.
// Returns the resulting document text after renumbering.
function renumber(text, selectedLineNums) {
  let lines = text.split('\n');
  const fakeEditor = {
    document: {
      languageId: 'rvmark',
      lineCount: lines.length,
      lineAt: i => ({ text: lines[i] }),
      uri: { fsPath: '/fake/test.rvmark' },
    },
    edit(callback) {
      const ops = [];
      const eb = {
        replace(range, newText) { ops.push({ type: 'replace', range, newText }); },
      };
      callback(eb);
      for (const op of ops) {
        const { start, end } = op.range;
        const line = lines[start.line];
        lines[start.line] = line.slice(0, start.character) + op.newText + line.slice(end.character);
      }
      return { then(fn) { fn(true); return this; } };
    },
  };
  renumberAfterEdit(fakeEditor, new Set(selectedLineNums));
  return lines.join('\n');
}

// ── collectNodes ──────────────────────────────────────────────────────────────

test('collectNodes: basic nodes', () => {
  const doc = makeDoc([
    '1. root',
    '  1. child',
    '  2. child2',
  ].join('\n'));
  const nodes = collectNodes(doc);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].ordinal, '1');
  assert.equal(nodes[0].depth, 1);
  assert.equal(nodes[1].depth, 2);
  assert.equal(nodes[2].ordinal, '2');
});

test('collectNodes: skips fenced code block contents', () => {
  const doc = makeDoc([
    '1. node',
    '  - {= block}',
    '```',
    '2. not a node',
    '```',
    '2. real node',
  ].join('\n'));
  const nodes = collectNodes(doc);
  const ordinals = nodes.map(n => n.ordinal);
  assert.deepEqual(ordinals, ['1', '-', '2']);
});

test('collectNodes: skips block body', () => {
  const doc = makeDoc([
    '1. parent',
    '  1. {= block}',
    '~~~',
    'Some text',
    '  2. fake node inside body',
    '~~~',
    '  2. real sibling',
  ].join('\n'));
  const nodes = collectNodes(doc);
  const ordinals = nodes.map(n => n.ordinal);
  assert.deepEqual(ordinals, ['1', '1', '2']);
});

test('collectNodes: skips block body with fenced block inside', () => {
  // The block body is opened by ~~~ and a nested ``` fence inside it does not
  // close the outer body (different fence char), so the fake nodes between the
  // inner fences are not collected.
  const doc = makeDoc([
    '1. {= block}',
    '~~~',
    'text',
    '```',
    '1. fake',
    '2. fake',
    '```',
    'more text',
    '  1. also fake node',
    '~~~',
    '2. real',
  ].join('\n'));
  const nodes = collectNodes(doc);
  assert.deepEqual(nodes.map(n => n.ordinal), ['1', '2']);
});

test('collectNodes: longer outer fence not closed by shorter inner fence', () => {
  // A body wrapped in a 4-backtick fence is not closed by a 3-backtick fence
  // inside it, so nodes between the inner fences stay inside the body.
  const doc = makeDoc([
    '1. parent',
    '  1. {= block}',
    '````',
    'Example:',
    '```',
    '  1. example child',
    '```',
    'More text.',
    '````',
    '  2. real sibling',
  ].join('\n'));
  const nodes = collectNodes(doc);
  assert.deepEqual(nodes.map(n => n.ordinal), ['1', '1', '2']);
});

// ── lintDocument: duplicate ordinals ─────────────────────────────────────────

test('lint: no false positive on unique ordinals', () => {
  const doc = makeDoc([
    '1. a',
    '2. b',
    '3. c',
  ].join('\n'));
  assert.equal(lintDocument(doc).length, 0);
});

test('lint: detects duplicate sibling ordinal', () => {
  const doc = makeDoc([
    '1. a',
    '2. b',
    '2. c',
  ].join('\n'));
  const diags = lintDocument(doc);
  assert.equal(diags.filter(d => d.message.includes('Duplicate ordinal "2"')).length, 1);
});

test('lint: no false positive for same ordinal in different subtrees', () => {
  const doc = makeDoc([
    '1. parent a',
    '  1. child',
    '  2. child',
    '2. parent b',
    '  1. child',
    '  2. child',
  ].join('\n'));
  assert.equal(lintDocument(doc).length, 0);
});

test('lint: no false positive when same top-level ordinal repeats and children share ordinals', () => {
  // Regression: two depth-1 nodes with ordinal "2" (in different sections of a large file)
  // must not make their depth-2 children collide with each other.
  const doc = makeDoc([
    '1. section a',
    '  2. {#format} child',
    '    1. grandchild',
    '2. section b',
    '  1. unrelated',
    '3. section c',
    '  2. another child under a different 3.',
    '    1. grandchild under 3.',
  ].join('\n'));
  assert.equal(lintDocument(doc).length, 0);
});

test('lint: detects duplicate within same subtree', () => {
  const doc = makeDoc([
    '1. parent',
    '  1. child',
    '  1. duplicate',
  ].join('\n'));
  const diags = lintDocument(doc);
  assert.equal(diags.filter(d => d.message.includes('Duplicate ordinal "1"')).length, 1);
});

test('lint: no false positive on auto-bullets', () => {
  const doc = makeDoc([
    '1. parent',
    '  - bullet',
    '  - bullet',
    '  - bullet',
  ].join('\n'));
  assert.equal(lintDocument(doc).length, 0);
});

test('lint: no false positive for ordinals inside block body', () => {
  const doc = makeDoc([
    '1. parent',
    '  1. {= block}',
    '~~~',
    '  1. fake node in code',
    '  2. fake node in code',
    '  2. fake duplicate in code',
    '~~~',
    '  2. real sibling',
  ].join('\n'));
  assert.equal(lintDocument(doc).length, 0);
});

// ── lintDocument: anchor checks ───────────────────────────────────────────────

test('lint: no warning for defined anchor ref', () => {
  const doc = makeDoc([
    '1. {#foo} target',
    '2. {=> #foo} ref',
  ].join('\n'));
  assert.equal(lintDocument(doc).length, 0);
});

test('lint: warns on undefined local anchor', () => {
  const doc = makeDoc([
    '1. {=> #missing} ref',
  ].join('\n'));
  const diags = lintDocument(doc);
  assert.equal(diags.filter(d => d.message.includes('#missing')).length, 1);
});

test('lint: embed shorthand {=> #anchor} works', () => {
  const doc = makeDoc([
    '1. {#bar} target',
    '2. {=> #bar} ref',
  ].join('\n'));
  assert.equal(lintDocument(doc).length, 0);
});

test('lint: transclude: syntax works', () => {
  const doc = makeDoc([
    '1. {#baz} target',
    '2. {transclude: #baz} ref',
  ].join('\n'));
  assert.equal(lintDocument(doc).length, 0);
});

// ── renumberAfterEdit ─────────────────────────────────────────────────────────

test('renumber: renumbers selected lines sequentially from 1', () => {
  // Simulates result after indenting lines 1-2 (0-indexed) into a new subtree,
  // then renumbering them. Selected = lines 1 and 2 (the moved nodes).
  const input = [
    '1. parent',
    '  3. a',  // these were 3,4 before, now selected to renumber
    '  4. b',
  ].join('\n');
  const result = renumber(input, [1, 2]);
  assert.equal(result, [
    '1. parent',
    '  1. a',
    '  2. b',
  ].join('\n'));
});

test('renumber: only touches leftmost indent level in selection', () => {
  // If selection spans multiple indent levels, only the leftmost (shallowest) is renumbered.
  const input = [
    '1. parent',
    '  3. a',
    '    5. grandchild',
    '  4. b',
  ].join('\n');
  // Select lines 1-3 (all of them after the parent). Leftmost indent = '  ' (depth 2).
  const result = renumber(input, [1, 2, 3]);
  assert.equal(result, [
    '1. parent',
    '  1. a',
    '    5. grandchild',  // deeper level untouched
    '  2. b',
  ].join('\n'));
});

test('renumber: does not touch unselected nodes, counts up from their max', () => {
  // Only lines 1-2 are selected; line 0 (ordinal "5") is unselected in the same group.
  // Max unselected = 5, so selected nodes get 6 and 7. Unselected "5." stays untouched.
  const input = [
    '5. unselected',
    '3. a',
    '4. b',
  ].join('\n');
  const result = renumber(input, [1, 2]);
  assert.equal(result, [
    '5. unselected',
    '6. a',
    '7. b',
  ].join('\n'));
});

test('renumber: does not touch nodes in different subtrees at same indent', () => {
  // Lines 1-2 are selected (children of node 0). Lines 4-5 are NOT selected.
  // They share indent '  ' but different parents — must not be renumbered.
  const input = [
    '1. parent a',
    '  3. a',
    '  4. b',
    '2. parent b',
    '  5. c',
    '  6. d',
  ].join('\n');
  const result = renumber(input, [1, 2]);
  assert.equal(result, [
    '1. parent a',
    '  1. a',
    '  2. b',
    '2. parent b',
    '  5. c',  // untouched
    '  6. d',
  ].join('\n'));
});

test('renumber: skips zero-padded and non-integer ordinals', () => {
  const input = [
    '1. parent',
    '  01. zero-padded — skip',
    '  a. alpha — skip',
    '  3. renumber this',
    '  4. renumber this',
  ].join('\n');
  const result = renumber(input, [1, 2, 3, 4]);
  assert.equal(result, [
    '1. parent',
    '  01. zero-padded — skip',
    '  a. alpha — skip',
    '  1. renumber this',
    '  2. renumber this',
  ].join('\n'));;
});

test('renumber: no-op when ordinals already correct', () => {
  const input = [
    '1. a',
    '2. b',
    '3. c',
  ].join('\n');
  const result = renumber(input, [0, 1, 2]);
  assert.equal(result, input);
});

test('renumber: selected node gets ordinal after max unselected sibling', () => {
  // "1. d" was outdented into a group with unselected siblings 1, 2, 3.
  // Max unselected integer ordinal = 3, so selected node gets 4.
  const input = [
    '1. a',
    '2. b',
    '3. c',
    '1. d',   // just outdented — selected, ordinal is stale
  ].join('\n');
  const result = renumber(input, [3]);
  assert.equal(result, [
    '1. a',
    '2. b',
    '3. c',
    '4. d',
  ].join('\n'));
});

test('renumber: indenting into group with existing node continues from max', () => {
  // "3. c" indented under "1. a" which already has unselected "  1. b". Max = 1, so gets 2.
  const input = [
    '1. a',
    '  1. b',
    '  3. c',   // just indented — selected
    '4. d',
  ].join('\n');
  const result = renumber(input, [2]);
  assert.equal(result, [
    '1. a',
    '  1. b',
    '  2. c',
    '4. d',   // unselected top-level — untouched
  ].join('\n'));
});

test('renumber: multiple selected nodes continue from max unselected', () => {
  // Three nodes indented into a group that already has unselected 1, 2.
  const input = [
    '1. a',
    '  1. x',   // unselected
    '  2. y',   // unselected
    '  5. b',   // selected — stale ordinal
    '  6. c',   // selected
    '  7. d',   // selected
  ].join('\n');
  const result = renumber(input, [3, 4, 5]);
  assert.equal(result, [
    '1. a',
    '  1. x',
    '  2. y',
    '  3. b',
    '  4. c',
    '  5. d',
  ].join('\n'));
});

// ── nextSiblingOrdinal ────────────────────────────────────────────────────────

test('nextSiblingOrdinal: basic sequential', () => {
  const doc = makeDoc([
    '1. parent',
    '  1. child a',
    '  2. child b',
  ].join('\n'));
  // Pressing Enter on line 2 (ordinal "2") should give 3.
  assert.equal(nextSiblingOrdinal(doc, 2), 3);
});

test('nextSiblingOrdinal: does not count cousins from different subtrees', () => {
  // Regression: continueNumbering was scanning all nodes at the same depth/indent
  // regardless of parent, causing it to pick up ordinals from unrelated subtrees.
  //
  // Structure mirrors the nd.rvmark bug:
  //   1. root
  //     1. {minor} ...
  //       1. child-of-minor        ← cousin at depth 3
  //     2. rules-of-inference
  //       1. Traditionally...      ← pressing Enter here
  //   2. second-top-level
  //     1. unrelated
  //       1. cousin a              ← cousin at depth 3, ordinal 1
  //       2. cousin b              ← cousin at depth 3, ordinal 2
  //
  // Without the fix, maxNum would be 2 (from cousin b) → returns 3 instead of 2.
  const doc = makeDoc([
    '1. root',
    '  1. minor',
    '    1. child-of-minor',
    '  2. rules-of-inference',
    '    1. Traditionally',
    '2. second-top-level',
    '  1. unrelated',
    '    1. cousin a',
    '    2. cousin b',
  ].join('\n'));
  // Pressing Enter on line 4 ("    1. Traditionally") — should give 2, not 3.
  assert.equal(nextSiblingOrdinal(doc, 4), 2);
});

// ── nextSiblingMarker ─────────────────────────────────────────────────────────

test('nextSiblingMarker: unordered dash repeats as-is (default)', () => {
  const doc = makeDoc([
    '- parent',
    '  - child a',
    '  - child b',
  ].join('\n'));
  assert.equal(nextSiblingMarker(doc, 2), '-');
});

test('nextSiblingMarker: unordered star repeats as-is', () => {
  const doc = makeDoc([
    '* parent',
    '  * child a',
  ].join('\n'));
  assert.equal(nextSiblingMarker(doc, 1), '*');
});

test('nextSiblingMarker: integer ordinal continues numbering', () => {
  const doc = makeDoc([
    '1. parent',
    '  1. child a',
    '  2. child b',
  ].join('\n'));
  assert.equal(nextSiblingMarker(doc, 2), '3.');
});

test('nextSiblingMarker: non-integer ordinal falls back to dash', () => {
  const doc = makeDoc([
    'a. parent',
    '  b. child a',
  ].join('\n'));
  assert.equal(nextSiblingMarker(doc, 1), '-');
});

test('nextSiblingMarker: non-node line returns null', () => {
  const doc = makeDoc('just some prose');
  assert.equal(nextSiblingMarker(doc, 0), null);
});

test('renumber: no unselected siblings — starts from 1', () => {
  // All siblings are selected, so max unselected = 0, counter starts at 1.
  const input = [
    '1. parent',
    '  5. a',
    '  6. b',
  ].join('\n');
  const result = renumber(input, [1, 2]);
  assert.equal(result, [
    '1. parent',
    '  1. a',
    '  2. b',
  ].join('\n'));
});
