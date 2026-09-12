# 2026-09-12 — recipes.json: a machine-readable export for Tachikoma

Task, relayed via a brief from Max's `homebot` project: publish a machine-readable
recipe export from this repo's Pages workflow. Tachikoma — a Slack bot Max and Naomi
share — will do meal planning ("what can we cook with these ingredients", "plan meals
for the week") and needs the collection in a form a model can read. The only prior
machine-readable artifact, a Paprika `.paprikarecipes` zip, was deleted as a test
export; the published HTML is the live source, so this build step parses it.

## The count: 247, not 231

The brief said 231. Measured against the export at `28c305b` (last commit to touch
`paprika-export/`, 2026-08-15): **247** recipe pages. The brief's number came from a
stale checkout in the `homebot` workspace — a submodule still pinned to the
2026-02-28 export, which genuinely held 231 pages — corrected on `homebot`'s side to
247 once the mismatch surfaced. Not a parsing discrepancy in this repo; the corpus
grew by 16 recipes between exports, and Max re-exports by hand on no fixed schedule.
That is also why nothing below gates on 247, or on any exact count: a collapse is the
signal worth catching, not a specific number.

## The size estimate was also wrong, and for the same root cause

The brief estimated ~0.11 MB. Measured plain-text volume per field across the corpus:

| field | ≈ bytes |
|---|---|
| directions | 309,000 |
| ingredients | 95,000 |
| notes | 51,000 |
| nutrition (not shipped) | 17,000 |
| description | 9,000 |

Ingredients alone is close to the brief's whole-file estimate — it reads as a partial
extraction measured before the JSON wrapper and the other included fields. The real
file is **530 KB** for all 247 recipes — still one fetch, still small enough to hand
a model in a single context, which is what actually mattered for the "no search
index, no embeddings" decision in the brief.

## The trap: nested quantity vs. ingredient line

Every ingredient line is `<p class="line" itemprop="recipeIngredient"><strong>QTY</strong>
rest of the line</p>`. A regex that stops at the first `</` — a very natural first
attempt — returns only the `<strong>` contents: `"1"`, `"1 3/4"`, `"2/3"`, and so on.
Verified on the probe recipe the brief names
(`Acorn Squash Stuffed with Walnut-Apple Basmati Pilaf.html`): the naive extraction
yields exactly the quantity list the brief warned about; matching to the ingredient
line's *own* closing `</p>` (not the first tag-close of any kind) yields the real
strings (`"1 cup brown basmati rice"`, `"1 3/4 cups water"`, …).

This isn't just a fact checked once by hand — it is a build gate. `verify-site.ts`
computes the fraction of ingredient strings across the whole published
`recipes.json` that are pure digits/fractions/whitespace and fails the build above
5%. Today that fraction is 0%; the naive bug would put it near 83%. A unit test pins
the same property on a representative fixture sample.

## Shape of the export, reused rather than re-derived

`build-index.ts` already parses `name` and `recipeCategory` (via `parseRecipe`) —
`build-recipes-json.ts` reuses that instead of re-deriving it, and exports the
module's existing `decodeEntities` (five entities: `&apos; &amp; &quot; &gt; &lt;`)
rather than duplicating it.

Everything else follows one of two shapes:

- **Flat lines** (`recipeIngredient`): each `<p class="line" itemprop="...">` is one
  string.
- **Paragraph containers** (`recipeInstructions`, `description`, `comment`): a `<div
  itemprop="...">` wrapping one or more `<p>` — confirmed **zero nested `<div>`** in
  any of the three across the whole corpus, so a non-greedy capture to the first
  `</div>` is safe. Directions become an array of steps (splitting on every `<p>`,
  not just `class="line"` — two recipes use a bare `<p>`); description and notes join
  their paragraphs with a blank line into prose. `<br/>` (256 occurrences in
  directions, 152 in notes) becomes a newline before tags are stripped.

`source`/`sourceUrl` read from one regex over
`<a itemprop="url" href="...">​<span itemprop="author">...</span></a>` — the two
itemprops always co-occur (229/229 recipes), so one match gets both the link text and
the href attribute (not its text, which the brief's own naive-parse warning implicitly
generalizes to: read the attribute you actually want, not whatever the tag's inner
text happens to be).

Nutrition, rating and all image data are omitted — image explicitly, per the brief;
nutrition/rating add bulk with no meal-planning value. Description, notes, and
difficulty are included: cheap, and useful context for a bot doing meal planning.

## Provenance, and why it can't fall back silently

```json
{ "generated": "...", "exportCommit": "...", "exportDate": "...", "count": 247, "recipes": [...] }
```

`exportDate` is the field the brief calls load-bearing: Max re-exports from Paprika by
hand, so the data can be months old while `generated` (the build timestamp) is
minutes old. It's derived from `git log -1 --format=%H%x1f%aI -- paprika-export`, not
from `HEAD` — the two routinely diverge (today, `HEAD` is 11 commits ahead of the last
export-touching commit). This needs full git history; the workflow's checkout was
depth-1, so `fetch-depth: 0` was added. The CLI throws rather than falling back to
build time if that lookup comes up empty — a silent fallback would defeat the whole
point of carrying provenance.

## Two real gaps in the data, handled as gaps, not failures

2 recipes have no ingredients (`Arroz Rojo (Mexican Tomato Rice)`, `Dumpling Soup`); 2
have no instructions (`Chickpea Overnight Salad`, `Dim Sum  Dumpling Sauce`). These
match `verify-site.ts`'s own long-standing refusal to assert ingredient/instruction
presence, for the same reason: real gaps in Max's library, not parser bugs. They parse
to empty arrays without throwing. The build gate does not hard-code these four names —
it derives the expected empty-ingredient set from the built HTML itself and asserts
`recipes.json` agrees, so the *shape* is checked (a parser that silently drops
ingredients elsewhere still fails the build) without pinning today's snapshot, since
the actual set can shift with the next hand-export.

## New `verify-site.ts` check

Added as check 6, matching the existing checks' set-equality style:

- `recipes.json` exists, parses, and `count === recipes.length`, with no duplicate ids
- recipe ids in `recipes.json` set-equal the built recipe pages, both directions
- the empty-ingredient set in `recipes.json` set-equals the pages that carry no
  `itemprop="recipeIngredient"` in the built HTML
- quantity-only ingredient ratio under 5% (see the trap section above)
- `exportCommit` is a full SHA, `exportDate`/`generated` parse as dates
- the serialized file contains no `Images/` substring and no `.jpg`/`.jpeg`

## Verification

`npm test`: 91 passing (68 pre-existing + 23 new, 13 for the parser and 10 added to
`verify-site.test.ts`).

Full local pipeline against the real 247-recipe export:

```
site: assembled from 247 recipe page(s)
recipes.json: built from 247 recipe page(s), export 28c305b
viewport: injected into 247 page(s), skipped 2 already carrying one
verified: 249 page(s) each with one viewport meta, 288 image(s) intact, recipes.json holds 247 recipe(s)
```

`recipes.json`: 530 KB, 247 recipes, `exportCommit` `28c305b731e0b0415106c4a9d5441bd107cde3cd`,
`exportDate` `2026-08-15T22:34:47+02:00`. `paprika-export/` unmodified
(`git status --porcelain` clean) after the full pipeline ran.

Spot-checked against the raw corpus counts: 39 recipes carry `description`, 111
carry `notes`, 12 carry `difficulty`, 31 carry `totalTime`, 184 carry `yield`, 118
carry at least one category, 229 carry `source`/`sourceUrl` — every one matches an
independent `git grep` count taken before writing the parser. Zero pure-numeric
ingredient strings across all 3,378+ lines in the built output. No `Images/` or
`.jpg` anywhere in the file.
