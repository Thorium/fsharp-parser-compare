# F# tree-sitter grammars, side by side

[Try here online](https://thorium.github.io/fsharp-parser-compare/)

A static page that loads **two** F# tree-sitter grammars as WASM and parses the same
source with both at once, showing highlighting, parse tree, and every ERROR/MISSING
node for each.

The two sides are *variants* picked from a registry, so this compares:

* two different repos — [`ionide/tree-sitter-fsharp`](https://github.com/ionide/tree-sitter-fsharp)
  against [`MangelMaxime/tree-sitter-fsharp`](https://github.com/MangelMaxime/tree-sitter-fsharp);
* two versions of the *same* repo — v0.5 against v0.6, `main` against the last release;
* a published build against one you just built locally;
* the same parser with two different `highlights.scm` — "is my query edit better or worse?"

Type in the editor, or open a local `.fs`/`.fsx`. `samples/everyday.fs` is loaded at
startup: a short tour of ordinary F# that both shipped grammars parse cleanly, so the
differences you see there are highlighting and tree shape rather than errors.

## What the panes show

* **Highlight** — the source coloured by that variant's `highlights.scm`, with every
  ERROR range in red and MISSING in amber.
* **Tree** — the parse tree, error nodes in red.
* **Errors** — one row per ERROR/MISSING node with its line, column and source line.

The per-pane stat line is the quick verdict: parse time, node count, tag count, and
`N ERROR · lost/total lines`.

Hovering a token in the Highlight view shows the node chain at that offset, the
`highlights.scm` capture that coloured it, and any `tags.scm` definition covering it.
tree-sitter has no hover of its own — that is an LSP concern — but `tags.scm` is what
drives GitHub's code navigation, so its `@definition.*` / `@name` pairs are the closest
thing a grammar alone can offer.

## Choosing what to compare

Everything is behind the **⚙ Grammars** button. Each side has:

* a **variant** dropdown, listing everything in `grammars/index.json`;
* three **override** slots — `parser.wasm`, `highlights.scm`, `tags.scm`. Anything you
  drop in replaces just that part of the chosen variant, is read straight from your
  machine (never uploaded), and applies immediately.

So "does my edited query behave better?" is: pick the variant on both sides, override
`highlights.scm` on one, and compare. Same for a freshly built `parser.wasm`.

## Managing variants

```bash
node scripts/variant.mjs ls            # what is registered

# build from a git ref — a URL is cloned into .cache/, a local path is used in place
# through a throwaway worktree, so your own checkout is never touched
node scripts/variant.mjs build --id ionide-0.3.2 --label "ionide 0.3.2" \
  --repo https://github.com/ionide/tree-sitter-fsharp --ref 0.3.2 --subdir fsharp

# register files you already have (a local build, a release artifact, one edited query)
node scripts/variant.mjs add --id wip --label "my branch" \
  --wasm ../build/parser.wasm --highlights ../my/queries/highlights.scm

node scripts/variant.mjs rm --id wip
```

### Upstream releases

```bash
node scripts/refresh.mjs                         # the 2 newest releases of each repo
node scripts/refresh.mjs --latest 3              # the 3 newest
node scripts/refresh.mjs --dry-run               # what would be added
node scripts/refresh.mjs --source ionide --tag 0.3.12
node scripts/refresh.mjs --all                   # every release with a wasm asset
```

Both repos attach `tree-sitter-fsharp.wasm` to their GitHub releases. `refresh.mjs`
makes sure the two newest releases of each repo are registered, as `ionide-<tag>` /
`maxim-<tag>`, and keeps older ones already there. Each is the release's own wasm
plus links to `queries/highlights.scm` and `queries/tags.scm` on raw.githubusercontent.com,
pinned to the tag's full commit sha. Each parser is loaded with this project's
`web-tree-sitter` before it is registered, so one the page runtime would refuse never
lands. `default` then points at the newest release of each repo; set `"pinDefault": true`
in `index.json` to keep a hand-picked pair.

Only the wasm is copied in: GitHub release downloads carry no CORS header, so the page
cannot fetch them. raw.githubusercontent.com does send `Access-Control-Allow-Origin: *`,
so the queries are fetched from upstream at load time and the page needs to be online
to colour anything.

`ionide-main` and `maxim-main` follow each repo's default branch: the newest release's
wasm plus the branch head's queries. That holds while no grammar file (`grammar.js`,
`src/`, `common/`) has changed since the release; query, test, CI and docs commits
are fine. Once the grammar has changed, `refresh.mjs` leaves the variant as it is and
prints a warning with the `variant.mjs build` command that rebuilds it. `--no-main`
skips this step. `variant.mjs rm` refuses to delete a release whose wasm a `-main`
variant still uses.

`.github/workflows/refresh.yml` runs this weekly on Mondays (and on demand from the
Actions tab) and commits what it changes to `main`. GitHub disables scheduled workflows after 60 days
without repository activity; re-enable it from the Actions tab if that happens.

`--subdir` is the grammar directory inside the repo (ionide keeps its grammar in
`fsharp/`; MangelMaxime's is at the root, so it needs no `--subdir`). Queries are taken
from `<subdir>/queries/` then `queries/`, or from `--queries <dir>`.

The CLI used for building is `node_modules/tree-sitter-cli` (pinned to the same version
as `vendor/web-tree-sitter.js` — a parser generated by a newer CLI than the runtime is
refused at load time with an ABI error). Override it with `$TREE_SITTER` if you need to.

### The registry file

`grammars/index.json` lists the variants and which two load by default:

```json
{
  "default": ["ionide-0.3.13", "maxim-0.2.1"],
  "variants": [
    { "id": "ionide-0.3.13", "label": "ionide 0.3.13", "version": "release 0.3.13 @ 12ed86c",
      "wasm": "ionide-0.3.13/parser.wasm",
      "highlights": "https://raw.githubusercontent.com/ionide/tree-sitter-fsharp/<sha>/queries/highlights.scm",
      "tags": "https://raw.githubusercontent.com/ionide/tree-sitter-fsharp/<sha>/queries/tags.scm" }
  ]
}
```

Paths are relative to `grammars/`. **A value starting with `http://` or `https://` is
fetched from there instead.** Upstream queries are linked this way rather than copied.
Two variants can share one wasm: each `-main` variant points at its newest release's
`parser.wasm`. The shipped `ionide-npm-latest` variant
tracks whatever ionide has published without costing this repo a byte:

```json
"wasm": "https://unpkg.com/tree-sitter-fsharp@latest/tree-sitter-fsharp.wasm"
```

unpkg serves the published npm package with `Access-Control-Allow-Origin: *` and
resolves `@latest` at load time. (jsDelivr refuses this package — over its 150 MB
limit. ionide also attaches `tree-sitter-fsharp.wasm` to each GitHub release, at
`releases/latest/download/tree-sitter-fsharp.wasm`, but the queries are not in the
release assets.) A remote variant costs a download on every page load, so keep the
ones you use constantly local.

## Run locally

```bash
node server.js      # http://localhost:5173
```

Any static server works — there is no build step, and nothing from `node_modules/` is
needed at runtime.

## Deploying to GitHub Pages

Everything is static and every path is relative, so it works unchanged from a project
page at `https://<user>.github.io/<repo>/`: push, then Settings → Pages → "Deploy from
a branch" → `main` / `/ (root)`. `.nojekyll` is present so the toolchain does not try
to process the files.

The grammar blobs are ~11 MB each — well inside GitHub's 100 MB per-file limit and the
1 GB Pages site limit, but every local variant you add makes the first visit heavier.

## Notes

* All tree-sitter work runs in a Web Worker: Chrome refuses synchronous WebAssembly
  instantiation on the main thread above 4 KB, and these modules are ~11 MB. Loaded
  languages and compiled queries are cached, so switching a pane back to something
  already seen is instant.
* Parse times shown are WASM times and are much slower than native — on a 46 KB file,
  ionide measured 3,850 ms in WASM vs 28 ms through the CLI (maxim: 243 ms vs 11 ms).
  On the 876 KB `ProvidedTypes.fs` from FSharp.TypeProviders.SDK it is 2,310 ms vs
  254 ms. Use them to compare variants against each other, not as absolute figures.
* Cached grammars are never freed: web-tree-sitter exposes no `delete()` on
  `Language`, so every variant selected in a session keeps its ~11 MB resident until
  you reload the page. Flipping through a dozen variants is fine; leaving the tab open
  for a day of them is not.
* `npm install` may skip `tree-sitter-cli`'s install script, which is what downloads
  the actual binary. If `variant.mjs build` says the CLI has no executable, run
  `node node_modules/tree-sitter-cli/install.js` from the project root, or set
  `$TREE_SITTER` to a CLI you already have.
* A `.scm` that does not compile against the selected parser is reported in the options
  panel and in the pane, with the CLI's own message (e.g. `Bad node name 'x'`) — the
  parse tree still renders.

## Third-party content

This repository redistributes build artifacts and query files from three upstream
projects. Full licence texts are in [`licenses/`](licenses/).

| Files here | From | Licence |
|---|---|---|
| `grammars/ionide-*/*` | [ionide/tree-sitter-fsharp](https://github.com/ionide/tree-sitter-fsharp) | MIT — © 2023 Nikolaj Sidorenco |
| `grammars/maxim-*/*` | [MangelMaxime/tree-sitter-fsharp](https://github.com/MangelMaxime/tree-sitter-fsharp) | Apache-2.0 — © 2026 Mangel Maxime |
| `vendor/web-tree-sitter.*` | [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) | MIT — © 2018 Max Brunsfeld |

The release variants (`ionide-<tag>`, `maxim-<tag>`) carry the `tree-sitter-fsharp.wasm`
asset from that GitHub release unchanged; a `-main` variant built with `variant.mjs build`
is an unmodified compilation of that project's committed grammar sources. Upstream `.scm` files are not stored here; they are linked
at a fixed commit. The `-wip` variants hold local edits. No upstream source was altered.
Variants you add yourself carry their own upstream licence — record it here if you
publish the result.

Everything else in this repository (`index.html`, `app.js`, `worker.js`, `style.css`,
`server.js`, `scripts/*.mjs`, `.github/workflows/*`, `samples/everyday.fs`) is original.
