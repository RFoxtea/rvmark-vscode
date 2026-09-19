const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// New syntax: <indent><ordinal>. <rest>
// Ordinal: any alphanumeric string, or - / *
const NODE_LINE  = /^( *)(?:([a-zA-Z0-9]+)\.|([*-]))\s+/;
const NODE_MEDIA = /\{[^}]*(?:=\s*block|type:\s*block)\b/;
const NODE_MEDIA_INLINE = /\{[^}]*(?:=\s*block|type:\s*block)[^}]*\}\s*\S/;
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})/;
const INT_ORDINAL = /^[1-9][0-9]*$/;

// ── Indent stack depth resolution ─────────────────────────────────────────────
function computeDepths(nodeRecords) {
  const indentStack = [''];
  const depths = [];
  for (const rec of nodeRecords) {
    const existing = indentStack.indexOf(rec.indent);
    let depth;
    if (existing !== -1) {
      depth = existing + 1;
      indentStack.length = existing + 1;
    } else {
      indentStack.push(rec.indent);
      depth = indentStack.length;
    }
    depths.push(depth);
  }
  return depths;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectNodes(document) {
  const nodes = [];
  let fenceChar   = null; // null = not in a fence; otherwise the fence char ('`' or '~')
  let fenceLen    = 0;
  let inMediaBody = false; // inside a body-type node's fenced body
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (fenceChar !== null) {
      // Inside a fence — look for the matching closing fence
      const closeM = text.match(/^([ \t]*)(`{3,}|~{3,})\s*$/);
      if (closeM && closeM[2][0] === fenceChar && closeM[2].length >= fenceLen) {
        fenceChar = null; fenceLen = 0;
        if (inMediaBody) { inMediaBody = false; }
      }
      continue;
    }
    if (inMediaBody) {
      // Waiting for the opening fence of a body-type node
      const openM = FENCE_OPEN.exec(text);
      if (openM) { fenceChar = openM[2][0]; fenceLen = openM[2].length; }
      continue;
    }
    // Outside any fence — check for node lines or fence opens
    const openM = FENCE_OPEN.exec(text);
    if (openM) { fenceChar = openM[2][0]; fenceLen = openM[2].length; continue; }
    const m = NODE_LINE.exec(text);
    if (m) {
      nodes.push({ lineIndex: i, indent: m[1], ordinal: m[2] || m[3], matchLen: m[0].length });
      if (NODE_MEDIA.test(text) && !NODE_MEDIA_INLINE.test(text)) inMediaBody = true;
    }
  }
  const depths = computeDepths(nodes);
  nodes.forEach((n, i) => { n.depth = depths[i]; });
  return nodes;
}

// True if `lineNum` is a real node line, i.e. one collectNodes found. A bare
// NODE_LINE test is not enough: prose inside a block body ("Pause. That I...")
// matches the word-ordinal form, and only fence tracking tells the two apart.
function nodeLineSet(document) {
  return new Set(collectNodes(document).map(n => n.lineIndex));
}

function isNodeLine(document, lineNum) {
  return nodeLineSet(document).has(lineNum);
}

function detectIndentUnit(document) {
  const nodes = collectNodes(document);
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].depth > nodes[i - 1].depth) {
      const diff = nodes[i].indent.length - nodes[i - 1].indent.length;
      if (diff > 0) return diff;
    }
  }
  return 2;
}

function subtreeRange(nodes, idx, lineCount) {
  const start = nodes[idx].lineIndex;
  const d = nodes[idx].depth;
  let end = lineCount - 1;
  for (let i = idx + 1; i < nodes.length; i++) {
    if (nodes[i].depth <= d) { end = nodes[i].lineIndex - 1; break; }
  }
  return [start, end];
}

// ── Linter ────────────────────────────────────────────────────────────────────

function lintDocument(document) {
  const diagnostics = [];
  const nodes = collectNodes(document);

  const sectionEnd = new Array(nodes.length).fill(document.lineCount - 1);
  const stack = [];
  for (let i = 0; i < nodes.length; i++) {
    while (stack.length > 0 && nodes[stack[stack.length - 1]].depth >= nodes[i].depth) {
      sectionEnd[stack.pop()] = nodes[i].lineIndex - 1;
    }
    stack.push(i);
  }

  // ── Duplicate ordinal check ────────────────────────────────────────────────
  // Track the nearest ancestor *index* at each depth level.
  // Two nodes are siblings iff they share the same parent index.
  const ancestorIdxStack = []; // ancestorIdxStack[depth-1] = index of nearest ancestor at that depth
  const ordinalSeen = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    ancestorIdxStack.length = node.depth - 1; // trim to parent depth
    const parentIdx = node.depth > 1 ? ancestorIdxStack[node.depth - 2] : -1;
    ancestorIdxStack[node.depth - 1] = i; // push self
    if (node.ordinal === '-' || node.ordinal === '*') continue;
    const key = parentIdx + '\x00' + node.ordinal;
    const col = node.indent.length;
    const range = new vscode.Range(node.lineIndex, col, node.lineIndex, col + node.ordinal.length + 1);
    if (ordinalSeen.has(key)) {
      diagnostics.push(new vscode.Diagnostic(
        range,
        `Duplicate ordinal "${node.ordinal}" (first at line ${ordinalSeen.get(key) + 1})`,
        vscode.DiagnosticSeverity.Error
      ));
    } else {
      ordinalSeen.set(key, node.lineIndex);
    }
  }

  const anchors = new Set();
  const refs = [];
  // An id declaration is any `;`-separated segment of an attribute block that
  // starts with '#', so it can follow the opening brace ({#foo}) or another
  // attribute ({= tr; #foo}) — matching parseAttrBlock in the engine.
  const ANCHOR_DEF_RE = /[{;]\s*#([a-zA-Z0-9_-]+)/g;
  const REFERENCE_RE  = /\{[^}]*?(?:transclude:\s*|=>\s*)([^;}\s]+)/g;

  let lintFenceChar = null;
  let lintFenceLen  = 0;
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (lintFenceChar !== null) {
      const closeM = text.match(/^([ \t]*)(`{3,}|~{3,})\s*$/);
      if (closeM && closeM[2][0] === lintFenceChar && closeM[2].length >= lintFenceLen) {
        lintFenceChar = null; lintFenceLen = 0;
      }
      continue;
    }
    const openM = FENCE_OPEN.exec(text);
    if (openM) { lintFenceChar = openM[2][0]; lintFenceLen = openM[2].length; continue; }
    if (!NODE_LINE.test(text)) continue;

    ANCHOR_DEF_RE.lastIndex = 0;
    let m;
    while ((m = ANCHOR_DEF_RE.exec(text)) !== null) anchors.add(m[1]);

    REFERENCE_RE.lastIndex = 0;
    while ((m = REFERENCE_RE.exec(text)) !== null) {
      refs.push({ target: m[1], lineIndex: i, col: m.index });
    }
  }

  const docDir = path.dirname(document.uri.fsPath);
  for (const { target, lineIndex, col } of refs) {
    const range = new vscode.Range(lineIndex, col, lineIndex, col + target.length + 9);
    if (target.startsWith('#')) {
      const id = target.slice(1);
      if (!anchors.has(id)) {
        diagnostics.push(new vscode.Diagnostic(
          range,
          `Anchor "#${id}" is not defined in this file`,
          vscode.DiagnosticSeverity.Warning
        ));
      }
    } else if (target.startsWith('./') || target.startsWith('../')) {
      const [filePart, anchor] = target.split('#');
      const candidates = [
        path.resolve(docDir, filePart),
        path.resolve(docDir, filePart + '.rvmark'),
        path.resolve(docDir, filePart, 'index.rvmark'),
      ];
      const resolvedPath = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
      if (!resolvedPath) {
        diagnostics.push(new vscode.Diagnostic(
          range,
          `Referenced file "${filePart}" not found`,
          vscode.DiagnosticSeverity.Warning
        ));
      } else if (anchor) {
        const fileText = fs.readFileSync(resolvedPath, 'utf8');
        const remoteAnchors = new Set();
        const re = /[{;]\s*#([a-zA-Z0-9_-]+)/g;
        let am;
        for (const line of fileText.split('\n')) {
          if (!NODE_LINE.test(line)) continue;
          re.lastIndex = 0;
          while ((am = re.exec(line)) !== null) remoteAnchors.add(am[1]);
        }
        if (!remoteAnchors.has(anchor)) {
          diagnostics.push(new vscode.Diagnostic(
            range,
            `Anchor "#${anchor}" is not defined in "${filePart}"`,
            vscode.DiagnosticSeverity.Warning
          ));
        }
      }
    }
  }

  return diagnostics;
}

// ── Folding ───────────────────────────────────────────────────────────────────

function provideFoldingRanges(document) {
  const ranges = [];
  const nodes = collectNodes(document);

  let mediaStart  = -1;  // line index of the body-type node line
  let fenceChar   = null;
  let fenceLen    = 0;
  let fenceStart  = -1;  // line index of the opening fence
  let inMediaBody = false;
  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (fenceChar !== null) {
      const closeM = text.match(/^([ \t]*)(`{3,}|~{3,})\s*$/);
      if (closeM && closeM[2][0] === fenceChar && closeM[2].length >= fenceLen) {
        if (inMediaBody && mediaStart !== -1) {
          ranges.push(new vscode.FoldingRange(fenceStart, i));
          mediaStart = -1;
          inMediaBody = false;
        }
        fenceChar = null; fenceLen = 0; fenceStart = -1;
      }
      continue;
    }
    if (inMediaBody) {
      const openM = FENCE_OPEN.exec(text);
      if (openM) { fenceChar = openM[2][0]; fenceLen = openM[2].length; fenceStart = i; }
      continue;
    }
    const openM = FENCE_OPEN.exec(text);
    if (openM) { fenceChar = openM[2][0]; fenceLen = openM[2].length; fenceStart = i; continue; }
    if (NODE_LINE.test(text) && NODE_MEDIA.test(text) && !NODE_MEDIA_INLINE.test(text)) {
      mediaStart = i; inMediaBody = true;
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const [start, end] = subtreeRange(nodes, i, document.lineCount);
    if (end > start) ranges.push(new vscode.FoldingRange(start, end));
  }

  return ranges;
}

// ── continueNumbering helper ──────────────────────────────────────────────────

// Returns the next integer ordinal for a new sibling inserted after `lineNum`.
// Exported for testing.
function nextSiblingOrdinal(doc, lineNum) {
  const lineText = doc.lineAt(lineNum).text;
  const m = NODE_LINE.exec(lineText);
  if (!m) return null;

  const indent = m[1];
  const nodes = collectNodes(doc);
  const curIdx = nodes.findIndex(n => n.lineIndex === lineNum);
  if (curIdx === -1) return null; // inside a body: not a node line
  const depth = nodes[curIdx].depth;

  // Find parent index (same logic as linter's ancestorIdxStack).
  const ancestorIdxStack = [];
  for (let i = 0; i <= curIdx; i++) {
    ancestorIdxStack.length = nodes[i].depth - 1;
    ancestorIdxStack[nodes[i].depth - 1] = i;
  }
  const parentIdx = depth > 1 ? (ancestorIdxStack[depth - 2] ?? -1) : -1;

  // Rebuild parentIdxOf for all nodes to find true siblings.
  const parentIdxOf = new Array(nodes.length).fill(-1);
  const stack2 = [];
  for (let i = 0; i < nodes.length; i++) {
    stack2.length = nodes[i].depth - 1;
    parentIdxOf[i] = nodes[i].depth > 1 ? (stack2[nodes[i].depth - 2] ?? -1) : -1;
    stack2[nodes[i].depth - 1] = i;
  }

  let maxNum = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (parentIdxOf[i] === parentIdx && n.indent === indent && INT_ORDINAL.test(n.ordinal)) {
      maxNum = Math.max(maxNum, parseInt(n.ordinal, 10));
    }
  }
  return maxNum + 1;
}

// Returns the marker text (no trailing space) for a new sibling inserted after
// `lineNum`, matching the current node's style. Unordered is the default: an
// unordered marker ('-' or '*') repeats as-is, an integer ordinal continues
// numbering, and any other explicit ordinal (e.g. 'a.', 'iv.') falls back to
// '-'. Returns null if `lineNum` is not a node line. Exported for testing.
function nextSiblingMarker(doc, lineNum) {
  const m = NODE_LINE.exec(doc.lineAt(lineNum).text);
  if (!m) return null;
  if (!isNodeLine(doc, lineNum)) return null;
  if (m[3]) return m[3]; // '-' or '*'
  if (INT_ORDINAL.test(m[2])) return String(nextSiblingOrdinal(doc, lineNum) ?? 1) + '.';
  return '-';
}

// ── Selection expansion ───────────────────────────────────────────────────────

// Classify every line of the document as owned by the node line that precedes it.
// Returns an array `ownerOf` where ownerOf[i] is the line index of the node line
// that line i belongs to (or -1 for lines that belong to no node — e.g. leading
// junk before the first node, or blank lines outside a body).
//
// A node line owns:
//   - its fenced body, if any (opening fence, content, closing fence), plus any
//     blank lines between the node line and the opening fence;
//   - the continuation lines that follow it (non-blank, non-node, outside a fence).
//
// Blank lines are only claimed when they sit inside a body or between the node
// line and its opening fence; a trailing blank line after a node ends its run so
// indenting a node doesn't drag along the whitespace separating it from the next.
function computeLineOwners(document) {
  const ownerOf = new Array(document.lineCount).fill(-1);
  let owner      = -1;   // current node line index
  let fenceChar  = null;
  let fenceLen   = 0;
  let awaitFence = false; // node declared a body; opening fence not seen yet
  let pendingBlanks = []; // blank lines held back until we know they're inside

  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;

    if (fenceChar !== null) {
      ownerOf[i] = owner;
      const closeM = text.match(/^([ \t]*)(`{3,}|~{3,})\s*$/);
      if (closeM && closeM[2][0] === fenceChar && closeM[2].length >= fenceLen) {
        fenceChar = null; fenceLen = 0;
      }
      continue;
    }

    if (awaitFence) {
      if (text.trim() === '') { pendingBlanks.push(i); continue; }
      const openM = FENCE_OPEN.exec(text);
      if (openM) {
        // The blanks we held back sit between the node line and its fence: claim them.
        for (const b of pendingBlanks) ownerOf[b] = owner;
        pendingBlanks = [];
        fenceChar = openM[2][0]; fenceLen = openM[2].length;
        ownerOf[i] = owner;
        awaitFence = false;
        continue;
      }
      // No body materialised after all — fall through and treat this like any
      // other line, leaving the held-back blanks unowned.
      pendingBlanks = [];
      awaitFence = false;
    }

    const m = NODE_LINE.exec(text);
    if (m) {
      owner = i;
      ownerOf[i] = i;
      // A body-type node with no inline value opens a fenced body next.
      awaitFence = NODE_MEDIA.test(text) && !NODE_MEDIA_INLINE.test(text);
      continue;
    }

    const openM = FENCE_OPEN.exec(text);
    if (openM) {
      // A stray fence outside a declared body still shields its contents.
      fenceChar = openM[2][0]; fenceLen = openM[2].length;
      ownerOf[i] = owner;
      continue;
    }

    if (text.trim() === '') { owner = -1; continue; } // blank line ends the run
    ownerOf[i] = owner; // continuation line
  }
  return ownerOf;
}

// Given the node lines the user selected, return the full set of lines that must
// move with them: the node lines themselves plus every line they own.
// Exported for testing.
function expandSelectionLines(document, nodeLines) {
  const ownerOf = computeLineOwners(document);
  const out = new Set(nodeLines);
  for (let i = 0; i < ownerOf.length; i++) {
    if (ownerOf[i] !== -1 && nodeLines.has(ownerOf[i])) out.add(i);
  }
  return out;
}

// ── Renumber helpers ──────────────────────────────────────────────────────────

// After an indent/outdent edit, renumber integer ordinals at the leftmost indent
// level among the selected lines. Finds the full sibling group (same indent, same
// parent) in the document and reassigns ordinals 1, 2, 3... in file order,
// but only edits lines whose ordinal actually needs to change.
function renumberAfterEdit(editor, selectedLineNums) {
  const doc = editor.document;
  const nodes = collectNodes(doc);

  // Leftmost indent among selected node lines (by indent string length).
  let minIndentLen = Infinity;
  for (const lineNum of selectedLineNums) {
    const m = NODE_LINE.exec(doc.lineAt(lineNum).text);
    if (m && m[1].length < minIndentLen) minIndentLen = m[1].length;
  }
  if (minIndentLen === Infinity) return;

  // Collect selected nodes at the leftmost indent level with integer ordinals.
  const INT_ORD = /^[1-9][0-9]*$/;
  const selectedAtMin = nodes.filter(n =>
    n.indent.length === minIndentLen &&
    selectedLineNums.has(n.lineIndex) &&
    INT_ORD.test(n.ordinal)
  );
  if (selectedAtMin.length === 0) return;

  // For each selected node at this level, find its full sibling group (same parent).
  // Build ancestor index stack to determine parent idx for each node.
  const ancestorIdxStack = [];
  const parentIdxOf = new Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) {
    ancestorIdxStack.length = nodes[i].depth - 1;
    parentIdxOf[i] = nodes[i].depth > 1 ? (ancestorIdxStack[nodes[i].depth - 2] ?? -1) : -1;
    ancestorIdxStack[nodes[i].depth - 1] = i;
  }

  // Group selected nodes by parent index — each group needs independent renumbering.
  const groups = new Map();
  for (const node of selectedAtMin) {
    const ni = nodes.indexOf(node);
    const pid = parentIdxOf[ni];
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(ni);
  }

  editor.edit(eb => {
    for (const [pid] of groups) {
      const siblings = nodes.filter((n, i) => parentIdxOf[i] === pid && INT_ORD.test(n.ordinal));

      // Max integer ordinal among unselected siblings — selected nodes count up from there.
      const maxUnselected = siblings
        .filter(n => !selectedLineNums.has(n.lineIndex))
        .reduce((max, n) => Math.max(max, parseInt(n.ordinal, 10)), 0);

      const toRenumber = siblings
        .filter(n => selectedLineNums.has(n.lineIndex))
        .sort((a, b) => a.lineIndex - b.lineIndex);

      let counter = maxUnselected + 1;
      for (const n of toRenumber) {
        const newOrdinal = String(counter++);
        if (newOrdinal !== n.ordinal) {
          const col = n.indent.length;
          eb.replace(
            new vscode.Range(n.lineIndex, col, n.lineIndex, col + n.ordinal.length),
            newOrdinal
          );
        }
      }
    }
  });
}

// ── Commands ──────────────────────────────────────────────────────────────────

function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider({ language: 'rvmark' }, { provideFoldingRanges })
  );

  // Tab: indent selected node lines one level deeper, then renumber.
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('rvmark.indentItem', (editor) => {
      const doc = editor.document;
      const sel = editor.selection;
      const unit = ' '.repeat(detectIndentUnit(doc));

      const startLine = Math.min(sel.start.line, sel.end.line);
      const endLine   = Math.max(sel.start.line, sel.end.line);
      const selectedLines = new Set();
      const nodeLines = nodeLineSet(doc);
      for (let i = startLine; i <= endLine; i++) {
        if (nodeLines.has(i)) selectedLines.add(i);
      }
      if (selectedLines.size === 0) { vscode.commands.executeCommand('tab'); return; }

      // Block bodies and continuation lines move with the node that owns them —
      // a body's closing fence must keep the same indent as its opening fence.
      const linesToShift = expandSelectionLines(doc, selectedLines);

      editor.edit(eb => {
        for (const lineNum of linesToShift) {
          // Don't indent blank lines — that would leave trailing whitespace.
          if (doc.lineAt(lineNum).text.trim() === '') continue;
          eb.insert(new vscode.Position(lineNum, 0), unit);
        }
      }).then(() => renumberAfterEdit(editor, selectedLines));
    })
  );

  // Shift+Tab: outdent selected node lines one level shallower, then renumber.
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('rvmark.outdentItem', (editor) => {
      const doc = editor.document;
      const sel = editor.selection;
      const unit = detectIndentUnit(doc);

      const startLine = Math.min(sel.start.line, sel.end.line);
      const endLine   = Math.max(sel.start.line, sel.end.line);
      const selectedLines = new Set();
      const nodeLines = nodeLineSet(doc);
      for (let i = startLine; i <= endLine; i++) {
        if (nodeLines.has(i)) selectedLines.add(i);
      }
      if (selectedLines.size === 0) { vscode.commands.executeCommand('outdentLines'); return; }

      // Owned lines (body + continuations) shift with their node line, and by the
      // *same* amount — a body's closing fence must keep its opening fence's indent,
      // and body content keeps its relative indentation.
      const ownerOf = computeLineOwners(doc);
      const shiftFor = new Map(); // node line -> columns actually removed
      for (const lineNum of selectedLines) {
        const currentIndent = doc.lineAt(lineNum).text.match(/^( *)/)[1].length;
        shiftFor.set(lineNum, Math.min(currentIndent, unit));
      }

      editor.edit(eb => {
        for (let i = 0; i < doc.lineCount; i++) {
          const ownerLine = selectedLines.has(i) ? i : ownerOf[i];
          if (ownerLine === -1 || !selectedLines.has(ownerLine)) continue;
          const text = doc.lineAt(i).text;
          const available = text.match(/^( *)/)[1].length;
          // Never eat non-whitespace: a body line indented less than its node
          // (or a blank line) just gives up whatever leading space it has.
          const remove = Math.min(available, shiftFor.get(ownerLine));
          if (remove > 0) eb.delete(new vscode.Range(i, 0, i, remove));
        }
      }).then(() => renumberAfterEdit(editor, selectedLines));
    })
  );

  // Alt+Up / Alt+Down: move a node and its whole subtree up or down among siblings.
  function moveNode(editor, direction) {
    const doc = editor.document;
    const lineNum = editor.selection.active.line;
    if (!isNodeLine(doc, lineNum)) {
      vscode.commands.executeCommand(
        direction === 'up' ? 'editor.action.moveLinesUpAction' : 'editor.action.moveLinesDownAction'
      );
      return;
    }

    const nodes = collectNodes(doc);
    const curIdx = nodes.findIndex(n => n.lineIndex === lineNum);
    if (curIdx === -1) return;

    const depth = nodes[curIdx].depth;
    const curIndent = nodes[curIdx].indent;

    let sibIdx = -1;
    if (direction === 'up') {
      for (let i = curIdx - 1; i >= 0; i--) {
        if (nodes[i].depth < depth) break;
        if (nodes[i].depth === depth && nodes[i].indent === curIndent) { sibIdx = i; break; }
      }
    } else {
      for (let i = curIdx + 1; i < nodes.length; i++) {
        if (nodes[i].depth < depth) break;
        if (nodes[i].depth === depth && nodes[i].indent === curIndent) { sibIdx = i; break; }
      }
    }
    if (sibIdx === -1) return;

    const [aStart, aEnd] = subtreeRange(nodes, Math.min(curIdx, sibIdx), doc.lineCount);
    const [bStart, bEnd] = subtreeRange(nodes, Math.max(curIdx, sibIdx), doc.lineCount);

    const aLines = [];
    const bLines = [];
    for (let i = aStart; i <= aEnd; i++) aLines.push(doc.lineAt(i).text);
    for (let i = bStart; i <= bEnd; i++) bLines.push(doc.lineAt(i).text);

    const newText = [...bLines, ...aLines].join('\n');
    const fullRange = new vscode.Range(aStart, 0, bEnd, doc.lineAt(bEnd).text.length);
    editor.edit(eb => eb.replace(fullRange, newText)).then(() => {
      const movedLine = direction === 'up' ? aStart : aStart + bLines.length;
      const pos = new vscode.Position(movedLine, editor.selection.active.character);
      editor.selection = new vscode.Selection(pos, pos);
    });
  }

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('rvmark.moveNodeUp',   (editor) => moveNode(editor, 'up'))
  );
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('rvmark.moveNodeDown', (editor) => moveNode(editor, 'down'))
  );

  // Enter: insert a new sibling node after the current one. Match the current
  // node's marker style: an unordered marker ('-' or '*') repeats as-is —
  // unordered is the default — while an integer ordinal continues numbering.
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('rvmark.continueNumbering', (editor) => {
      const doc = editor.document;
      const sel = editor.selection;
      const lineNum = sel.active.line;
      const lineText = doc.lineAt(lineNum).text;
      const m = NODE_LINE.exec(lineText);
      const marker = m && nextSiblingMarker(doc, lineNum);
      if (!marker) { vscode.commands.executeCommand('type', { text: '\n' }); return; }

      const indent = m[1];
      const prefix = indent + marker + ' ';

      if (sel.active.character === 0) {
        editor.edit(eb => eb.insert(new vscode.Position(lineNum, 0), prefix + '\n')).then(() => {
          const cur = new vscode.Position(lineNum, prefix.length);
          editor.selection = new vscode.Selection(cur, cur);
        });
      } else {
        editor.edit(eb => eb.insert(sel.active, '\n' + prefix)).then(() => {
          const cur = new vscode.Position(lineNum + 1, prefix.length);
          editor.selection = new vscode.Selection(cur, cur);
        });
      }
    })
  );

  // ── Linter ──────────────────────────────────────────────────────────────────
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('rvmark');
  context.subscriptions.push(diagnosticCollection);

  function lint(document) {
    if (document.languageId !== 'rvmark') return;
    diagnosticCollection.set(document.uri, lintDocument(document));
  }

  vscode.workspace.textDocuments.forEach(lint);
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(lint));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => lint(e.document)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(
    doc => diagnosticCollection.delete(doc.uri)
  ));
}

module.exports = { activate, lintDocument, collectNodes, renumberAfterEdit, nextSiblingOrdinal, nextSiblingMarker, computeLineOwners, expandSelectionLines };
