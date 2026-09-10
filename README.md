# F# tree-sitter grammars, side by side

A static page that loads **two** F# tree-sitter grammars as WASM and parses the same
source with both at once, showing highlighting, parse tree, and every ERROR/MISSING
node for each:

* [`ionide/tree-sitter-fsharp`](https://github.com/ionide/tree-sitter-fsharp) — the `fsharp` grammar
* [`MangelMaxime/tree-sitter-fsharp`](https://github.com/MangelMaxime/tree-sitter-fsharp)

Type in the editor, or open a local `.fs`/`.fsx`. `samples/everyday.fs` is loaded at
startup: a short tour of ordinary F# that both grammars parse cleanly, so the
differences you see are highlighting and tree shape rather than errors.

## What the panes show

* **Highlight** — the source coloured by that repo's `queries/highlights.scm`, with every
  ERROR range in red and MISSING in amber.
* **Tree** — the parse tree, error nodes in red.
* **Errors** — one row per ERROR/MISSING node with its line, column and source line.

Hovering a token in the Highlight view shows the node chain at that offset, the
`highlights.scm` capture that coloured it, and any `tags.scm` definition covering it.
tree-sitter has no hover of its own — that is an LSP concern — but `tags.scm` is what
drives GitHub's code navigation, so its `@definition.*` / `@name` pairs are the closest
thing a grammar alone can offer.

The header bar carries a light / dark / follow-system toggle; the choice is remembered
in `localStorage`.

## Run locally

```bash
node server.js      # http://localhost:5173
```

Any static server works — there is no build step and no runtime dependency on npm.
`node_modules/` is only used to refresh `vendor/`.

## Deploying to GitHub Pages

Everything is static and every path is relative, so it works unchanged from a project
page at `https://<user>.github.io/<repo>/`: push the repo, then Settings → Pages →
"Deploy from a branch" → `main` / `/ (root)`. `.nojekyll` is present so the toolchain
does not try to process the files.

The two `grammars/*.wasm` files are ~11 MB each — well inside GitHub's 100 MB per-file
limit and the 1 GB Pages site limit, but they do make a first visit a ~22 MB download.

## Regenerating the grammars

```bash
# from a checkout of each grammar repo, with tree-sitter CLI 0.26.11
tree-sitter build --wasm -o /path/to/grammars/ionide.wasm fsharp     # in ionide/
tree-sitter build --wasm -o /path/to/grammars/maxim.wasm             # in MangelMaxime/
```

Then copy each repo's `queries/highlights.scm` to `grammars/<name>-highlights.scm`.

To refresh the runtime: `npm install web-tree-sitter@<version>` and copy
`web-tree-sitter.js` + `web-tree-sitter.wasm` into `vendor/`. The runtime version must
match the CLI that generated the grammars.

## Notes

* All tree-sitter work runs in a Web Worker: Chrome refuses synchronous WebAssembly
  instantiation on the main thread above 4 KB, and these modules are ~11 MB.
* Parse times shown are WASM times and are much slower than native — on a 46 KB file,
  ionide measured 3,850 ms in WASM vs 28 ms through the CLI (maxim: 243 ms vs 11 ms).
  On the 876 KB `ProvidedTypes.fs` from FSharp.TypeProviders.SDK it is 2,310 ms vs 254 ms.
  Use them to compare the two grammars against each other, not as absolute figures.

## Third-party content

This repository redistributes build artifacts and query files from three upstream
projects. Full licence texts are in [`licenses/`](licenses/).

| Files here | From | Licence |
|---|---|---|
| `grammars/ionide.wasm`, `grammars/ionide-{highlights,tags}.scm` | [ionide/tree-sitter-fsharp](https://github.com/ionide/tree-sitter-fsharp) | MIT — © 2023 Nikolaj Sidorenco |
| `grammars/maxim.wasm`, `grammars/maxim-{highlights,tags}.scm` | [MangelMaxime/tree-sitter-fsharp](https://github.com/MangelMaxime/tree-sitter-fsharp) | Apache-2.0 — © 2026 Mangel Maxime |
| `vendor/web-tree-sitter.*` | [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) | MIT — © 2018 Max Brunsfeld |

The `.wasm` files are unmodified compilations of each project's committed grammar
sources, produced with tree-sitter CLI 0.26.11; the `.scm` files are byte-for-byte
copies of each project's `queries/highlights.scm` and `queries/tags.scm`, renamed only
so both can sit in one directory. No upstream source was altered.

Everything else in this repository (`index.html`, `app.js`, `worker.js`, `style.css`,
`server.js`, `samples/everyday.fs`) is original.
