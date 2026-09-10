// UI only. Everything tree-sitter lives in worker.js.

const SAMPLE = { url: 'samples/everyday.fs', label: 'everyday.fs — a tour of ordinary F#' };
const SLOTS = ['A', 'B'];

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const views = { A: 'hl', B: 'hl' };
/** Per slot: which variant is picked, and any local file standing in for part of it. */
const cfg = {
  A: { variant: null, over: { wasm: null, highlights: null, tags: null } },
  B: { variant: null, over: { wasm: null, highlights: null, tags: null } },
};
let registry = { variants: [], default: [] };
let last = null;        // most recent worker result, reused on tab switches
// One counter for every message sent to the worker. Separate per-kind counters would
// collide in the shared `id` field: a failing parse posts {type:'error', id} carrying
// a parse id, which could match — and wrongly reject — a pending load.
let msgId = 0;
let seq = 0;                 // id of the newest parse request
const waiting = new Map();   // message id -> {resolve, reject}

/* ---------------------------------------------------------------- theme --- */

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: '◐ system', light: '☀ light', dark: '☾ dark' };
let theme = 'system';

function applyTheme(t) {
  theme = t;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  $('theme').textContent = THEME_LABEL[t];
  try { localStorage.setItem('theme', t); } catch { /* private mode, or site data blocked */ }
}

function initTheme() {
  let t = 'system';
  try { t = localStorage.getItem('theme') || 'system'; } catch { /* as above */ }
  applyTheme(THEMES.includes(t) ? t : 'system');
  $('theme').addEventListener('click', () =>
    applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]));
}

/* --------------------------------------------------------------- worker --- */

// Applied before the grammars load so there is no flash of the wrong theme.
initTheme();

const worker = new Worker('worker.js', { type: 'module' });

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'at') {
    if (m.id === tipReq) showTip(m.slot, m.chain);
    return;
  }
  if (m.type === 'parse') {
    if (m.id !== seq) return;          // a newer keystroke already superseded this
    last = m.result;
    paint();
    setStatus('ready');
    return;
  }
  const w = waiting.get(m.id);
  if (!w) {
    if (m.type === 'error') fail(m.message);
    return;
  }
  waiting.delete(m.id);
  if (m.type === 'error') w.reject(new Error(m.message)); else w.resolve(m);
};
worker.onerror = (e) => fail('worker failed: ' + e.message);

function ask(msg) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

const setStatus = t => { $('status').textContent = t; $('status').classList.remove('bad'); };
const fail = t => { $('status').textContent = t; $('status').classList.add('bad'); console.error(t); };

/* -------------------------------------------------------------- variants --- */

const variantById = id => registry.variants.find(v => v.id === id);
/** Manifest paths are relative to grammars/; anything absolute is left alone. */
const resolveUrl = p => /^https?:\/\//i.test(p) ? p : 'grammars/' + p;

/** Turn a slot's variant + overrides into the spec the worker loads. */
async function specFor(slotId) {
  const c = cfg[slotId];
  const v = variantById(c.variant);
  if (!v) throw new Error(`no variant selected for ${slotId}`);

  const wasmOver = c.over.wasm;
  const spec = {
    label: v.label + (wasmOver || c.over.highlights || c.over.tags ? ' + local' : ''),
    wasmKey: wasmOver ? `local:${wasmOver.name}:${wasmOver.size}:${wasmOver.stamp}` : `url:${v.wasm}`,
    wasm: wasmOver ? { bytes: wasmOver.bytes } : { url: resolveUrl(v.wasm) },
  };
  for (const part of ['highlights', 'tags']) {
    const o = c.over[part];
    if (o) {
      spec[part === 'highlights' ? 'hlKey' : 'tagKey'] = `local:${o.name}:${o.size}:${o.stamp}`;
      spec[part] = { text: o.text };
    } else if (v[part]) {
      spec[part === 'highlights' ? 'hlKey' : 'tagKey'] = `url:${v[part]}`;
      spec[part] = { url: resolveUrl(v[part]) };
    } else {
      spec[part === 'highlights' ? 'hlKey' : 'tagKey'] = 'none';
      spec[part] = null;
    }
  }
  return spec;
}

async function loadSlot(slotId) {
  const spec = await specFor(slotId);
  setStatus(`loading ${spec.label}…`);
  $('stats-' + slotId).innerHTML = '<span class="ln">loading…</span>';
  // The wasm bytes are structured-cloned to the worker rather than transferred: a
  // transfer would detach the buffer here, and this copy is reused every time the
  // slot reloads (a query override reloads the slot too).
  const m = await ask({ type: 'load', slot: slotId, spec });
  // Only now is this really the grammar in the pane — on failure the previous one
  // stays loaded, so the header must keep naming it.
  $('name-' + slotId).textContent = spec.label;
  const v = variantById(cfg[slotId].variant);
  $('meta-' + slotId).innerHTML =
    `<span>${esc(v.version)}</span> · ABI ${m.meta.abi} · ${m.meta.nodeTypes} node types` +
    (m.meta.hlError ? ` · <span class="bad">highlights.scm rejected</span>` : '') +
    (m.meta.tagError ? ` · <span class="bad">tags.scm rejected</span>` : '');
  return m.meta;
}

function fillPickers() {
  for (const slotId of SLOTS) {
    const sel = $('pick-' + slotId);
    sel.innerHTML = '';
    for (const v of registry.variants) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = `${v.label} — ${v.version}`;
      sel.append(o);
    }
    sel.value = cfg[slotId].variant;
    sel.addEventListener('change', async () => {
      cfg[slotId].variant = sel.value;
      reload(slotId);
    });
  }
}

function wireOverrides() {
  for (const input of document.querySelectorAll('#opts input[type=file]')) {
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      const slotId = input.dataset.slot, part = input.dataset.part;
      const common = { name: f.name, size: f.size, stamp: f.lastModified };
      cfg[slotId].over[part] = part === 'wasm'
        ? { ...common, bytes: await f.arrayBuffer() }
        : { ...common, text: await f.text() };
      $(`ovr-${slotId}-${part}`).innerHTML =
        `<b>${esc(f.name)}</b> · ${f.size.toLocaleString()} b`;
      reload(slotId);
    });
  }
  for (const btn of document.querySelectorAll('#opts [data-reset]')) {
    btn.addEventListener('click', async () => {
      const slotId = btn.dataset.reset;
      cfg[slotId].over = { wasm: null, highlights: null, tags: null };
      for (const part of ['wasm', 'highlights', 'tags']) {
        $(`ovr-${slotId}-${part}`).textContent = 'from variant';
        const inp = document.querySelector(`#opts input[data-slot="${slotId}"][data-part="${part}"]`);
        if (inp) inp.value = '';
      }
      reload(slotId);
    });
  }
}

/** Reload one slot and re-parse. On failure the previously loaded grammar stays
 *  active, so put the old numbers back rather than leaving "loading…" on screen. */
async function reload(slotId) {
  try { await loadSlot(slotId); parse(); }
  catch (e) { fail(`${slotId}: ${e.message}`); paint(); }
}

/* ---------------------------------------------------------------- parse --- */

function parse() {
  hideTip();
  setStatus('parsing…');
  // An 11MB grammar in WASM can take seconds on a large file; say so per pane
  // rather than leaving stale numbers on screen.
  for (const id of SLOTS) $('stats-' + id).innerHTML = '<span class="ln">parsing…</span>';
  worker.postMessage({ type: 'parse', id: seq = ++msgId, src: $('src').value });
}

function paint() {
  if (!last) return;
  for (const id of SLOTS) {
    const r = last[id];
    if (!r) continue;
    $('stats-' + id).innerHTML =
      `<b>${r.ms.toFixed(1)} ms</b> · ${r.nodes} nodes · ${r.tags.length} tags · ` +
      (r.errors + r.missing
        ? `<span class="bad">${r.errors} ERROR${r.missing ? ` + ${r.missing} MISSING` : ''}</span>` +
          ` · <span class="bad">${r.lost}/${r.lines} lines</span>`
        : 'clean');
    $('out-' + id).innerHTML = r[views[id]];
  }
}

/* -------------------------------------------------------------- tooltip --- */
// tree-sitter has no hover of its own; this is the node chain plus what
// highlights.scm and tags.scm say about the token under the cursor.

let tipReq = 0, tipAt = null, tipXY = [0, 0], tipCap = null;   // tipReq: id of the newest hover request

function offsetFromPoint(pre, x, y) {
  const r = document.caretRangeFromPoint
    ? document.caretRangeFromPoint(x, y)
    : (() => {
        const p = document.caretPositionFromPoint?.(x, y);
        if (!p) return null;
        const rr = document.createRange();
        rr.setStart(p.offsetNode, p.offset);
        return rr;
      })();
  if (!r || !pre.contains(r.startContainer)) return null;
  const span = document.createRange();
  span.setStart(pre, 0);
  span.setEnd(r.startContainer, r.startOffset);
  return span.toString().length;
}

function hideTip() { $('tip').hidden = true; tipAt = null; }

function showTip(slotId, chain) {
  const tip = $('tip');
  if (!chain || !chain.length) { hideTip(); return; }
  const inner = chain[0];
  const tag = last?.[slotId]
    ? last[slotId].tags.find(t => inner.si < t.ei && inner.ei > t.si)
    : null;

  // Anonymous nodes are literal tokens; quote them the way tree-sitter does.
  const label = n => esc(n.missing ? 'MISSING ' + n.type : n.named ? n.type : `"${n.type}"`);
  const path = chain.map((n, i) =>
    i === 0 ? `<b class="${n.bad ? 'bad' : ''}">${label(n)}</b>`
            : `<span class="up">${label(n)}</span>`).join(' <span class="up">‹</span> ');

  tip.innerHTML =
    `<div class="row chain"><span class="kind">node</span>${path}</div>` +
    `<div class="row"><span class="kind">at</span>${inner.row + 1}:${inner.col} · ${inner.si}–${inner.ei}</div>` +
    `<div class="row"><span class="kind">capture</span>` +
      (tipCap ? `<span class="cap">@${esc(tipCap)}</span>` : `<span class="none">none</span>`) + `</div>` +
    `<div class="row"><span class="kind">tag</span>` +
      (tag ? `<span class="tagdef">@${esc(tag.kind)}</span> ${esc(tag.text)}`
           : `<span class="none">none</span>`) + `</div>`;

  tip.hidden = false;
  const [x, y] = tipXY;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + 'px';
  tip.style.top = (y + r.height + 22 > innerHeight ? y - r.height - 10 : y + 18) + 'px';
}

function wireTooltip() {
  for (const body of document.querySelectorAll('.pane-body')) {
    const id = body.dataset.id;
    const pre = $('out-' + id);
    body.addEventListener('mousemove', (e) => {
      if (views[id] !== 'hl' || !last) { hideTip(); return; }
      const off = offsetFromPoint(pre, e.clientX, e.clientY);
      if (off == null) { hideTip(); return; }
      tipXY = [e.clientX, e.clientY];
      if (off === tipAt) return;
      tipAt = off;
      // elementFromPoint, not e.target: the pointer may be over a text node
      // whose parent carries no capture, and synthetic events target the body.
      tipCap = document.elementFromPoint(e.clientX, e.clientY)
        ?.closest?.('[data-c]')?.dataset.c ?? null;
      worker.postMessage({ type: 'at', id: tipReq = ++msgId, slot: id, offset: off });
    });
    body.addEventListener('mouseleave', hideTip);
  }
}

/* ------------------------------------------------------------------ UI ---- */

function wire() {
  $('src').addEventListener('input', debounce(parse, 250));
  $('file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    $('src').value = await f.text();
    $('fname').textContent = `${f.name} · ${f.size.toLocaleString()} bytes`;
    parse();
  });
  $('opts-toggle').addEventListener('click', () => {
    const open = $('opts').hidden;
    $('opts').hidden = !open;
    $('opts-toggle').setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('.tabs').forEach(tabs => {
    tabs.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
      views[tabs.dataset.for] = btn.dataset.view;
      hideTip();
      paint();
    });
  });
  syncScroll();
  wireTooltip();
}

async function loadSample() {
  try {
    const text = await (await fetch(SAMPLE.url)).text();
    $('src').value = text;
    $('fname').textContent = `${SAMPLE.label} · ${text.length.toLocaleString()} bytes`;
  } catch {
    $('fname').textContent = 'sample failed to load — open a file instead';
  }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function syncScroll() {
  const bodies = [...document.querySelectorAll('.pane-body')];
  let lock = false;
  bodies.forEach(b => b.addEventListener('scroll', () => {
    if (lock || !$('sync').checked) return;
    lock = true;
    for (const o of bodies) if (o !== b) { o.scrollTop = b.scrollTop; o.scrollLeft = b.scrollLeft; }
    requestAnimationFrame(() => { lock = false; });
  }));
}

/* ---------------------------------------------------------------- boot ---- */

async function boot() {
  setStatus('loading registry…');
  registry = await (await fetch('grammars/index.json')).json();
  if (!registry.variants?.length) throw new Error('grammars/index.json lists no variants');

  const [a, b] = registry.default ?? [];
  cfg.A.variant = variantById(a)?.id ?? registry.variants[0].id;
  cfg.B.variant = variantById(b)?.id ?? registry.variants[1]?.id ?? registry.variants[0].id;

  wire();
  fillPickers();
  wireOverrides();

  setStatus('starting tree-sitter…');
  await ask({ type: 'init' });
  await loadSample();
  for (const id of SLOTS) await loadSlot(id);
  parse();
}

boot().catch(e => fail('startup failed: ' + (e.message || e)));
