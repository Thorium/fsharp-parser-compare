// All tree-sitter work happens here: Chrome refuses synchronous WebAssembly
// instantiation on the main thread once the module exceeds 4KB, and these
// grammars are ~11MB each.
import { Parser, Language, Query } from './vendor/web-tree-sitter.js';

const GRAMMARS = [
  { id: 'ionide', wasm: 'grammars/ionide.wasm',
    hl: 'grammars/ionide-highlights.scm', tags: 'grammars/ionide-tags.scm' },
  { id: 'maxim', wasm: 'grammars/maxim.wasm',
    hl: 'grammars/maxim-highlights.scm', tags: 'grammars/maxim-tags.scm' },
];

const CLASS_OF = [
  [/^comment/, 'c'], [/^string|^character/, 's'], [/^number|^float|^integer/, 'n'],
  [/^keyword|^conditional|^repeat|^include|^exception|^storageclass|^boolean/, 'k'],
  [/^function|^method|^constructor/, 'f'],
  [/^type|^namespace|^module|^struct|^class|^interface/, 't'],
  [/^attribute|^annotation|^decorator/, 'a'],
  [/^operator/, 'o'], [/^punctuation|^delimiter|^bracket/, 'p'],
  [/^variable|^parameter|^property|^field|^label|^constant/, 'v'],
];
const cssClass = name => (CLASS_OF.find(([re]) => re.test(name)) || [null, 'v'])[1];
const esc = s => s.replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const MAX_ERROR_ROWS = 500;
const engines = {};

async function loadQuery(lang, url) {
  try {
    return { query: new Query(lang, await (await fetch(url)).text()), error: null };
  } catch (e) {
    return { query: null, error: String(e && e.message || e) };
  }
}

async function init() {
  await Parser.init();
  const meta = {};
  for (const g of GRAMMARS) {
    const lang = await Language.load(g.wasm);
    const parser = new Parser();
    parser.setLanguage(lang);
    const hl = await loadQuery(lang, g.hl);
    const tags = await loadQuery(lang, g.tags);
    engines[g.id] = { parser, hlQuery: hl.query, hlError: hl.error, tagQuery: tags.query, tree: null };
    meta[g.id] = {
      abi: lang.abiVersion, nodeTypes: lang.nodeTypeCount,
      hlError: hl.error, tagError: tags.error,
    };
  }
  return meta;
}

/** Every ERROR / MISSING node, plus every source line one of them touches. */
function collectErrors(tree) {
  const list = [], lines = new Set();
  const cur = tree.walk();
  const visit = () => {
    const n = cur.currentNode;
    if (n.type === 'ERROR' || n.isMissing) {
      list.push({
        kind: n.isMissing ? 'MISSING' : 'ERROR', type: n.type,
        row: n.startPosition.row, col: n.startPosition.column,
        si: n.startIndex, ei: n.endIndex,
      });
      let last = n.endPosition.row;
      if (last > n.startPosition.row && n.endPosition.column === 0) last--;
      for (let r = n.startPosition.row; r <= last; r++) lines.add(r);
    }
    if (!n.hasError && !n.isMissing) return;  // no error can be below this node
    if (cur.gotoFirstChild()) {
      do { visit(); } while (cur.gotoNextSibling());
      cur.gotoParent();
    }
  };
  visit();
  return { list, lost: lines.size };
}

function countNodes(tree) {
  let n = 0;
  const cur = tree.walk();
  const walk = () => {
    n++;
    if (cur.gotoFirstChild()) { do { walk(); } while (cur.gotoNextSibling()); cur.gotoParent(); }
  };
  walk();
  return n;
}

/**
 * tags.scm gives what tree-sitter has instead of hover: for each definition it
 * captures the defining node as @definition.<kind> and its identifier as @name.
 * Pair them up into ranges the UI can look up by cursor offset.
 */
function collectTags(engine, tree, src) {
  if (!engine.tagQuery) return [];
  const out = [];
  let matches;
  try { matches = engine.tagQuery.matches(tree.rootNode); } catch { return []; }
  for (const m of matches) {
    const def = m.captures.find(c => c.name.startsWith('definition.'));
    const name = m.captures.find(c => c.name === 'name');
    if (!def) continue;
    const anchor = name || def;
    out.push({
      si: anchor.node.startIndex, ei: anchor.node.endIndex,
      kind: def.name,
      text: src.slice(anchor.node.startIndex, anchor.node.endIndex).slice(0, 80),
      row: anchor.node.startPosition.row,
    });
  }
  out.sort((a, b) => a.si - b.si);
  return out;
}

function highlightHtml(src, engine, tree, errs) {
  const cap = new Array(src.length).fill(null);   // capture name per character
  if (engine.hlQuery) {
    const caps = engine.hlQuery.captures(tree.rootNode);
    // outer first, inner last, so the narrowest capture wins each character
    caps.sort((a, b) => a.node.startIndex - b.node.startIndex ||
                        b.node.endIndex - a.node.endIndex);
    for (const c of caps)
      for (let i = c.node.startIndex; i < c.node.endIndex && i < cap.length; i++) cap[i] = c.name;
  }
  const mark = new Array(src.length).fill(null);
  for (const e of errs.list) {
    const k = e.kind === 'MISSING' ? 'miss' : 'err';
    const end = Math.max(e.ei, e.si + 1);   // zero-width MISSING still needs a marker
    for (let i = e.si; i < end && i < mark.length; i++) mark[i] = k;
  }

  let html = '', run = '', runKey = null, runCap = null;
  const flush = () => {
    if (!run) return;
    html += runKey
      ? `<span class="${runKey}"${runCap ? ` data-c="${esc(runCap)}"` : ''}>${esc(run)}</span>`
      : esc(run);
    run = '';
  };
  for (let i = 0; i < src.length; i++) {
    const c = cap[i];
    const key = [c ? cssClass(c) : null, mark[i]].filter(Boolean).join(' ') || null;
    if (key !== runKey || c !== runCap) { flush(); runKey = key; runCap = c; }
    run += src[i];
  }
  flush();

  const note = engine.hlError
    ? `<div class="fail">highlights.scm did not compile: ${esc(engine.hlError)}</div>`
    : '';
  return note + html;
}

function treeHtml(tree, limit = 30000) {
  const parts = [];
  let n = 0, truncated = false;
  const cur = tree.walk();
  const walk = (depth) => {
    if (truncated) return;
    if (n++ > limit) { truncated = true; return; }
    const node = cur.currentNode;
    if (node.isNamed) {
      const field = cur.currentFieldName;
      const bad = node.type === 'ERROR' || node.isMissing;
      const label = node.isMissing ? `MISSING ${node.type}` : node.type;
      parts.push('  '.repeat(depth) +
        (field ? `<span class="tree-field">${esc(field)}: </span>` : '') +
        `<span class="${bad ? 'tree-err' : 'tree-t'}">${esc(label)}</span>` +
        ` <span class="ln">[${node.startPosition.row + 1}:${node.startPosition.column}]</span>`);
    }
    if (cur.gotoFirstChild()) {
      do { walk(depth + (node.isNamed ? 1 : 0)); } while (cur.gotoNextSibling() && !truncated);
      cur.gotoParent();
    }
  };
  walk(0);
  if (truncated) parts.push(`<span class="ln">… truncated at ${limit} nodes</span>`);
  return parts.join('\n');
}

function errorsHtml(src, errs) {
  if (!errs.list.length) return '<div class="note">No ERROR or MISSING nodes.</div>';
  const lines = src.split('\n');
  const shown = errs.list.slice(0, MAX_ERROR_ROWS);
  const rows = shown.map(e => {
    const line = lines[e.row] ?? '';
    const excerpt = line.length > 110 ? line.slice(0, 110) + '…' : line;
    return `<div class="errrow"><span>${e.row + 1}:${e.col}</span>` +
           `<span class="tree-err">${e.kind}</span>` +
           `<span>${esc(excerpt) || '<span class="ln">(blank line)</span>'}</span></div>`;
  });
  if (errs.list.length > shown.length)
    rows.push(`<div class="note">… ${errs.list.length - shown.length} more not listed</div>`);
  return rows.join('');
}

function run(src) {
  const result = {};
  for (const g of GRAMMARS) {
    const engine = engines[g.id];
    if (engine.tree) { engine.tree.delete(); engine.tree = null; }

    const t0 = performance.now();
    const tree = engine.parser.parse(src);
    const ms = performance.now() - t0;
    if (!tree) throw new Error(`${g.id}: parser returned no tree`);
    engine.tree = tree;                       // kept alive for hover lookups

    const errs = collectErrors(tree);
    result[g.id] = {
      ms,
      nodes: countNodes(tree),
      errors: errs.list.filter(e => e.kind === 'ERROR').length,
      missing: errs.list.length - errs.list.filter(e => e.kind === 'ERROR').length,
      lost: errs.lost,
      lines: src.length ? src.split('\n').length : 0,
      tags: collectTags(engine, tree, src),
      hl: highlightHtml(src, engine, tree, errs),
      tree: treeHtml(tree),
      err: errorsHtml(src, errs),
    };
  }
  return result;
}

/**
 * The node chain at a character offset — the closest thing to a hover.
 * Starts at the innermost node INCLUDING anonymous ones: the named descendant
 * alone would report `named_module` for a cursor sitting on the `module`
 * keyword, which says nothing about the token actually under the pointer.
 */
function nodeAt(paneId, offset) {
  const engine = engines[paneId];
  if (!engine || !engine.tree) return null;
  const node = engine.tree.rootNode.descendantForIndex(offset, offset);
  if (!node) return null;
  const chain = [];
  for (let n = node; n && chain.length < 6; n = n.parent) {
    chain.push({
      type: n.type, si: n.startIndex, ei: n.endIndex,
      row: n.startPosition.row, col: n.startPosition.column,
      named: n.isNamed,
      bad: n.type === 'ERROR' || n.isMissing,
      missing: n.isMissing,
    });
  }
  return chain;
}

self.onmessage = async (e) => {
  const { type, id, src, paneId, offset } = e.data;
  try {
    if (type === 'init') self.postMessage({ type: 'init', id, meta: await init() });
    else if (type === 'parse') self.postMessage({ type: 'parse', id, result: run(src) });
    else if (type === 'at') self.postMessage({ type: 'at', id, paneId, chain: nodeAt(paneId, offset) });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
  }
};
