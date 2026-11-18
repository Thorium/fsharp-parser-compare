// grammars/index.json access, shared by variant.mjs and refresh.mjs.

import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const GRAMMARS = path.join(ROOT, 'grammars');
export const INDEX = path.join(GRAMMARS, 'index.json');

/** Manifest entries may be repo-relative paths or absolute URLs fetched at load time. */
export const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);

export function readIndex() {
  if (!fs.existsSync(INDEX)) return { variants: [] };
  return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
}

export function writeIndex(idx) {
  idx.variants.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + '\n');
}

export function upsert(entry) {
  const idx = readIndex();
  const i = idx.variants.findIndex(v => v.id === entry.id);
  if (i >= 0) idx.variants[i] = entry; else idx.variants.push(entry);
  writeIndex(idx);
  console.log(`${i >= 0 ? 'updated' : 'added'} variant "${entry.id}"`);
}
