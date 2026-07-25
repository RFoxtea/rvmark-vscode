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
  const ANCHOR_DEF_RE = /\{#([a-zA-Z0-9_-]+)/g;
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
        const re = /\{#([a-zA-Z0-9_-]+)/g;
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
  if (curIdx === -1) return null;
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
  if (m[3]) return m[3]; // '-' or '*'
  if (INT_ORDINAL.test(m[2])) return String(nextSiblingOrdinal(doc, lineNum) ?? 1) + '.';
  return '-';
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
      for (let i = startLine; i <= endLine; i++) {
        if (NODE_LINE.test(doc.lineAt(i).text)) selectedLines.add(i);
      }
      if (selectedLines.size === 0) { vscode.commands.executeCommand('tab'); return; }

      editor.edit(eb => {
        for (const lineNum of selectedLines) eb.insert(new vscode.Position(lineNum, 0), unit);
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
      for (let i = startLine; i <= endLine; i++) {
        if (NODE_LINE.test(doc.lineAt(i).text)) selectedLines.add(i);
      }
      if (selectedLines.size === 0) { vscode.commands.executeCommand('outdentLines'); return; }

      editor.edit(eb => {
        for (const lineNum of selectedLines) {
          const text = doc.lineAt(lineNum).text;
          const currentIndent = text.match(/^( *)/)[1].length;
          const remove = Math.min(currentIndent, unit);
          if (remove > 0) eb.delete(new vscode.Range(lineNum, 0, lineNum, remove));
        }
      }).then(() => renumberAfterEdit(editor, selectedLines));
    })
  );

  // Alt+Up / Alt+Down: move a node and its whole subtree up or down among siblings.
  function moveNode(editor, direction) {
    const doc = editor.document;
    const lineNum = editor.selection.active.line;
    if (!NODE_LINE.test(doc.lineAt(lineNum).text)) {
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
      if (!m) { vscode.commands.executeCommand('type', { text: '\n' }); return; }

      const indent = m[1];
      const prefix = indent + nextSiblingMarker(doc, lineNum) + ' ';

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

module.exports = { activate, lintDocument, collectNodes, renumberAfterEdit, nextSiblingOrdinal, nextSiblingMarker };
