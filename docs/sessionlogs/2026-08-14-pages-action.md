# 2026-08-14 — Pages action, phase 1: viewport fix

Goal: post-process the Paprika export before it is published to Pages. Phase 1 is
the mobile fix and a working deploy pipeline. Index, category indexes, `_Proven`
collection and search are phase 2.

## Corrections to the starting brief

The brief was written against the `projects/Recipes` submodule in home-workspace,
pinned at `f662227` (2026-02-28). Measured against the real HEAD (`bc11fa9`,
committed today):

| Brief | Actual |
|---|---|
| 231 recipes | **247** |
| export ~6 months stale, re-export needed | **current** — matches the live library |
| `min-width: 1024px` blocks mobile | **no `min-width` anywhere in the export** |
| 106 categorised / 125 without | **118 / 129** |
| `_Proven` = 64 | **71** |

The real mobile blocker is that **none of the 248 HTML files carry a viewport meta
tag**, so phones assume a ~980px layout viewport and render everything zoomed out.

Categories also contain more entries than the brief listed (Fermentation 2, South
American, Side, Maroccan, Easter-European, Caribbean, BBQ) and more typos than just
`Mediterrean` — `Maroccan`, `Easter-European`, and both `Side` and `Side Dishes`
exist as separate categories. These must be displayed verbatim, never merged.

## Publishing

The brief flagged a risk that switching Pages to Actions could break the
`code.178.is` custom domain. It cannot:

- `gh api repos/eins78/Recipes/pages` → `cname: null`
- `gh api repos/eins78/eins78.github.io/pages` → `cname: "code.178.is"`

The domain is configured on the **user site repo**. `code.178.is/Recipes/` is the
automatically derived project path, independent of this repo's build type.

Max switched Pages to `build_type: "workflow"` himself. Verified. The switch also
flipped `https_enforced` to `true`, so the canonical URL is now `https://`.

Consequence worth remembering: **Jekyll is now out of the loop.** `/Recipes/` was
`README.md` rendered by Jekyll's default theme — a page that exists nowhere in the
repo. Once a workflow deploys, only what the workflow emits is served. So the build
runs `actions/jekyll-build-pages` itself, the same builder the legacy path used, and
injects into its output. `/Recipes/` keeps working unchanged.

## What was built

- `tools/inject-viewport.ts` — inserts the viewport meta after `<head>` in every
  page of the built site.
- `tools/verify-site.ts` — post-build assertions.
- `tools/walk.ts` — shared directory walk, NFC-normalising.
- `.github/workflows/pages.yml` — test → Jekyll build → inject → verify → assert
  export untouched → upload → deploy (deploy skipped on PRs).

### Decisions

**String insertion, not a DOM round-trip.** The export contains unescaped `&` inside
hrefs (16 files), curly quotes, CJK/Hangul/Hebrew, and two U+200E bidi marks in
`Grilled Eggplant Salad (‎חצילים ‎סלט).html`. Parsing and re-serialising would
silently rewrite all of that. A string splice cannot. The injector asserts per file
that it added exactly the meta tag's byte length and nothing else.

**No dependencies.** Node 24 runs TypeScript directly via native type stripping, and
`node --test` is the test runner. Started with vitest; pnpm blocked on esbuild's
postinstall, which was a good prompt to drop it. CI needs no install step.

**No `paths:` filter on the workflow.** Every file in the repo is an input to the
Jekyll build — `README.md` becomes the `/Recipes/` landing page — so filtering could
only produce a stale deploy.

**Per-job permissions.** The build job gets `contents: read`; only deploy gets
`pages: write` + `id-token: write`.

**What is deliberately not asserted:** presence of ingredients, instructions, source,
yield or categories. Those are genuinely absent from some recipes (2, 2, 18, 63 and
129 files) — real gaps in the library, not parse failures. Asserting them would fail
the build on correct input.

A first design of the injector failed the build when zero pages were injected. That
was wrong twice over: it broke re-runs, and a future export that ships its own
viewport meta would be correct yet fail. Replaced with "found no HTML at all", which
is the honest wrong-directory signal. Whether pages ended up tagged is verify-site's
job.

## Verification

Ran against the real 248-file export locally:

```
viewport: injected into 248 page(s), skipped 0 already carrying one
verified: 248 page(s) each with one viewport meta, 288 image(s) intact
```

`git status --porcelain -- paprika-export` clean afterwards. Re-run injects 0, skips
248, exits 0.

**The mobile check needed a correction.** First attempt used Playwright's
`browser_resize` to 390px and measured `clientWidth` — it reported 375 both before
and after, proving nothing. Desktop Chromium ignores the viewport meta entirely; the
tag only takes effect under mobile emulation. Redone with CDP
`Emulation.setDeviceMetricsOverride` and `mobile: true`:

| | before | after |
|---|---|---|
| viewport meta | none | `width=device-width, initial-scale=1` |
| layout viewport | 980px | 390px |
| scrollWidth | 980px | 390px (no horizontal overflow) |

Swept 12 pages chosen for awkward filenames and content (bidi marks, CJK, Hangul,
double spaces, unescaped `&`, curly apostrophe, multi-photo, nutrition table): zero
overflow, all tagged.

Max's read was right — the viewport tag alone is sufficient. The pages are linear
documents; they reflow cleanly at 390px with no CSS changes.

### What the PR build caught that local runs could not

Three things, all found before anything deployed — the PR build uploads an artifact
without deploying:

1. **`EACCES` on the first write.** `jekyll-build-pages` runs in a container as root,
   so `_site` came back root-owned. Fixed by taking ownership before post-processing.
2. **The action versions were several majors behind** (checkout v4→v7, setup-node
   v4→v7, configure-pages v5→v6, upload-pages-artifact v3→v5, deploy-pages v4→v5);
   the runner was warning about forced Node 20→24. Inputs unchanged across those
   majors.
3. **Jekyll published the build tooling.** The artifact contained `tools/`,
   `package.json` and `docs/` — including this sessionlog rendered into a public HTML
   page. Fixed with a `_config.yml` `exclude:` list.

### Artifact inspection (the exact bytes that would deploy)

- 249 pages, every one with exactly one viewport meta; 288 images intact
- `248 injected, 2 skipped` — the 2 are Jekyll's own generated pages, which already
  carry a viewport from the theme. The skip rule earns its keep here.
- **Base path confirmed:** the landing page references
  `/Recipes/assets/css/style.css`, matching the live site. This was the one risk not
  verifiable locally.
- Diffed against the live landing page: identical apart from `http://` → `https://`
  in the canonical and og URLs, because `https_enforced` flipped when Pages moved to
  Actions. The new build is the more correct one.
- Re-checked under mobile emulation against the artifact: 8 pages, no overflow, all
  tagged, all images loading.

## Deferred

Phase 2: index, category indexes, `_Proven` (71), search, and the landing-page
question — that one presupposes the index exists, so it gets re-asked with the index
in hand. Also noted: PhotoSwipe is broken three independent ways and covers only
50/247 pages; 181 recipe thumbnails hotlink to third-party image URLs; no page has a
`<title>`. `apple-mobile-web-app-*` tags were deliberately not injected — they only
affect saved-to-homescreen standalone mode.

Repo weight is worth watching: `.git` is 81 MB and every export churns UUID-named
JPEGs, so history grows unboundedly. Not addressed here.
