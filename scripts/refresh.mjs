#!/usr/bin/env node
// Register GitHub releases of the upstream grammars as variants in grammars/index.json.
//
//   node scripts/refresh.mjs                  the 2 newest releases of each repo, plus any
//                                             release newer than the newest registered
//   node scripts/refresh.mjs --latest 3       keep the 3 newest instead
//   node scripts/refresh.mjs --all            every release that has a wasm asset
//   node scripts/refresh.mjs --source ionide --tag 0.3.12
//   node scripts/refresh.mjs --dry-run        list what would be added, change nothing
//   node scripts/refresh.mjs --prerelease     include pre-releases
//
// Each release becomes `<source>-<tag>` (leading "v" dropped): the release's own
// tree-sitter-fsharp.wasm plus queries/highlights.scm and queries/tags.scm at that tag.
// The files are copied in because GitHub release downloads carry no CORS header, so the
// page cannot fetch them from GitHub at load time.
//
// Older release variants already registered are kept. Afterwards `default` points at
// the newest release of each source, unless index.json has "pinDefault": true.
//
// Set GITHUB_TOKEN (or GH_TOKEN) to lift the API limit of 60 requests an hour.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, GRAMMARS, readIndex, writeIndex } from './registry.mjs';

const SOURCES = [
  { key: 'ionide', label: 'ionide', repo: 'ionide/tree-sitter-fsharp' },
  { key: 'maxim', label: 'maxim', repo: 'MangelMaxime/tree-sitter-fsharp' },
];
const ASSET = 'tree-sitter-fsharp.wasm';
const QUERIES = ['highlights', 'tags'];

const die = (msg) => { console.error('error: ' + msg); process.exit(1); };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) die(`unexpected argument "${a}"`);
    out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

/* ---------------------------------------------------------------- github --- */

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

/** The token goes to api.github.com only; downloads redirect to other hosts. */
async function api(route, accept = 'application/vnd.github+json') {
  const headers = { Accept: accept, 'User-Agent': 'fsharp-parser-compare-refresh' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/${route}`, { headers });
  if (!res.ok) die(`GitHub API ${route}: ${res.status} ${await res.text()}`);
  return accept.endsWith('sha') ? (await res.text()).trim() : res.json();
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'fsharp-parser-compare-refresh' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Published, wasm-carrying releases of one source, newest first. */
async function releases(src, withPre) {
  const all = await api(`repos/${src.repo}/releases?per_page=100`);
  return all
    .filter(r => !r.draft && (withPre || !r.prerelease))
    .map(r => ({ tag: r.tag_name, published: r.published_at,
                 asset: r.assets.find(x => x.name === ASSET) }))
    .filter(r => r.asset)
    .sort((a, b) => b.published.localeCompare(a.published));
}

const variantId = (src, tag) => `${src.key}-${tag.replace(/^v/, '')}`;

/* ---------------------------------------------------------------- verify --- */

let runtime;

/**
 * Load the wasm with this project's web-tree-sitter (the same version as vendor/) and
 * parse the startup sample, so a parser the page would refuse (an ABI too new for the
 * runtime) is never registered. Query compile errors are only reported: the page shows
 * them too, and the parse tree still renders.
 */
async function verify(wasm, queries) {
  if (runtime === undefined) {
    const js = path.join(ROOT, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.js');
    runtime = fs.existsSync(js) ? await import(pathToFileURL(js).href) : null;
    if (runtime) await runtime.Parser.init();
    else console.warn('  note: node_modules/web-tree-sitter missing (npm ci); skipping load check');
  }
  if (!runtime) return;
  const lang = await runtime.Language.load(wasm);
  const parser = new runtime.Parser();
  parser.setLanguage(lang);
  parser.parse(fs.readFileSync(path.join(ROOT, 'samples', 'everyday.fs'), 'utf8'));
  for (const [name, text] of Object.entries(queries)) {
    try { new runtime.Query(lang, text); }
    catch (e) { console.warn(`  warning: ${name}.scm does not compile: ${e.message}`); }
  }
}

/* ------------------------------------------------------------------ main --- */

async function fetchRelease(src, rel) {
  const id = variantId(src, rel.tag);
  const wasm = await download(rel.asset.browser_download_url);
  if (wasm.subarray(0, 4).toString('latin1') !== '\0asm') throw new Error(`${ASSET} is not WebAssembly`);

  const queries = {};
  for (const q of QUERIES) {
    try {
      queries[q] = (await download(
        `https://raw.githubusercontent.com/${src.repo}/${encodeURIComponent(rel.tag)}/queries/${q}.scm`)).toString('utf8');
    } catch { console.warn(`  note: no queries/${q}.scm at ${rel.tag}`); }
  }
  await verify(wasm, queries);

  const sha = (await api(`repos/${src.repo}/commits/${encodeURIComponent(rel.tag)}`,
    'application/vnd.github.sha')).slice(0, 7);

  const dir = path.join(GRAMMARS, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'parser.wasm'), wasm);
  const entry = {
    id,
    label: `${src.label} ${rel.tag.replace(/^v/, '')}`,
    version: `release ${rel.tag} @ ${sha} (${rel.published.slice(0, 10)})`,
    repo: `https://github.com/${src.repo}`,
    release: { source: src.key, tag: rel.tag, published: rel.published },
    wasm: `${id}/parser.wasm`,
  };
  for (const [q, text] of Object.entries(queries)) {
    fs.writeFileSync(path.join(dir, `${q}.scm`), text);
    entry[q] = `${id}/${q}.scm`;
  }
  return entry;
}

const a = parseArgs(process.argv.slice(2));
if (a.help) {
  console.log(fs.readFileSync(import.meta.filename, 'utf8')
    .split('\n').slice(1).filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}
if (a.tag && !a.source) die('--tag needs --source (' + SOURCES.map(s => s.key).join(' or ') + ')');
const sources = a.source ? SOURCES.filter(s => s.key === a.source) : SOURCES;
if (!sources.length) die(`unknown --source "${a.source}"`);

const keep = a.latest === undefined ? 2 : Number(a.latest);
if (!Number.isInteger(keep) || keep < 1) die(`--latest must be a positive whole number (got "${a.latest}")`);

const idx = readIndex();
const added = [];
let failed = false;

for (const src of sources) {
  const rels = await releases(src, a.prerelease);
  const known = idx.variants.filter(v => v.release?.source === src.key);
  const newest = known.map(v => v.release.published).sort().at(-1);

  let todo;
  if (a.tag) {
    todo = rels.filter(r => r.tag === a.tag);
    if (!todo.length) die(`${src.repo} has no release "${a.tag}" with ${ASSET}`);
  } else if (a.all) todo = rels;
  else todo = rels.filter((r, i) => i < keep || (newest && r.published > newest));

  todo = todo.filter(r => a.force || a.tag || !idx.variants.some(v => v.id === variantId(src, r.tag)));
  if (!todo.length) { console.log(`${src.key}: up to date (${rels[0]?.tag ?? 'no releases'})`); continue; }

  for (const rel of todo.reverse()) {
    const id = variantId(src, rel.tag);
    if (a['dry-run']) { console.log(`${src.key}: would add ${id}`); continue; }
    console.log(`${src.key}: fetching ${rel.tag} …`);
    try {
      const entry = await fetchRelease(src, rel);
      const i = idx.variants.findIndex(v => v.id === id);
      if (i >= 0) idx.variants[i] = entry; else idx.variants.push(entry);
      added.push(id);
      console.log(`  added ${id} — ${entry.version}`);
    } catch (e) {
      failed = true;
      fs.rmSync(path.join(GRAMMARS, id), { recursive: true, force: true });
      console.error(`  error: ${id}: ${e.message}`);
    }
  }
}

if (!a['dry-run']) {
  if (!idx.pinDefault) {
    const latest = SOURCES.map(s => idx.variants
      .filter(v => v.release?.source === s.key)
      .sort((x, y) => y.release.published.localeCompare(x.release.published))[0]?.id);
    if (latest.every(Boolean) && String(latest) !== String(idx.default)) {
      idx.default = latest;
      console.log(`default: ${latest.join(' vs ')}`);
    }
  }
  writeIndex(idx);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `added=${added.join(' ')}\n`);
}
process.exit(failed ? 1 : 0);
