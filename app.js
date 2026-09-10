// UI only. Everything tree-sitter lives in worker.js.

const SAMPLE = {
  url: 'samples/everyday.fs',
  label: 'everyday.fs — a tour of ordinary F#',
};

const IDS = ['ionide', 'maxim'];
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const views = { ionide: 'hl', maxim: 'hl' };
let last = null;        // most recent worker result, reused on tab switches
let seq = 0;

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

// Applied before the grammars load (~5s) so there is no flash of the wrong theme.
initTheme();

const worker = new Worker('worker.js', { type: 'module' });

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    for (const id of IDS) {
      const meta = m.meta[id];
      $('ver-' + id).textContent = `ABI ${meta.abi}, ${meta.nodeTypes} node types`;
      if (meta.hlError) console.warn(`${id} highlights.scm: ${meta.hlError}`);
      if (meta.tagError) console.warn(`${id} tags.scm: ${meta.tagError}`);
    }
    $('status').textContent = 'ready';
    wire();
    loadSample();
  } else if (m.type === 'parse') {
    if (m.id !== seq) return;          // a newer keystroke already superseded this
    last = m.result;
    paint();
    $('status').textContent = 'ready';
  } else if (m.type === 'at') {
    if (m.id !== tipReq) return;      // the pointer has moved on since this was asked
    showTip(m.paneId, m.chain);
  } else if (m.type === 'error') {
    $('status').textContent = 'error: ' + m.message;
    console.error(m.message);
  }
};
worker.onerror = (e) => { $('status').textContent = 'worker failed: ' + e.message; };
worker.postMessage({ type: 'init', id: 0 });

function parse() {
  hideTip();
  $('status').textContent = 'parsing…';
  // An 11MB grammar in WASM can take seconds on a large file; say so per pane
  // rather than leaving stale numbers on screen.
  for (const id of IDS) $('stats-' + id).innerHTML = '<span class="ln">parsing…</span>';
  worker.postMessage({ type: 'parse', id: ++seq, src: $('src').value });
}

function paint() {
  if (!last) return;
  for (const id of IDS) {
    const r = last[id];
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

let tipReq = 0, tipAt = null, tipXY = [0, 0], tipCap = null;

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

function showTip(paneId, chain) {
  const tip = $('tip');
  if (!chain || !chain.length) { hideTip(); return; }
  const inner = chain[0];
  const tag = last
    ? last[paneId].tags.find(t => inner.si < t.ei && inner.ei > t.si)
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
      worker.postMessage({ type: 'at', id: ++tipReq, paneId: id, offset: off });
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
  $('status').textContent = 'loading sample…';
  try {
    const text = await (await fetch(SAMPLE.url)).text();
    $('src').value = text;
    $('fname').textContent = `${SAMPLE.label} · ${text.length.toLocaleString()} bytes`;
  } catch (e) {
    $('fname').textContent = 'sample failed to load — open a file instead';
  }
  parse();
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
