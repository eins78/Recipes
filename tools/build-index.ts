/**
 * Generates the recipe index that replaces Paprika's flat alphabetical list at
 * paprika-export/index.html.
 *
 * Shape follows the data, measured against the export:
 *   247 recipes, but only 118 carry any category — 129 (52%) carry none. So the
 *   complete A-Z list leads and categories are a way in, not the organising
 *   principle; a category-only index would hide over half the library.
 *   Multi-membership is the norm, not the exception: 87 of the 118 categorised
 *   recipes sit in two or more categories, so each appears in every list it
 *   belongs to.
 *   No thumbnails: the 288 photos average 134 KB, so a grid would be a ~31 MB
 *   page and would undo the phase 1 mobile work.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isHtml, relativeFilesUnder } from "./walk.ts";

/** Max's own curation tags (_Proven, _Mealprep, _Sourdough) rather than cuisines. */
export const CURATION_PREFIX = "_";

export interface Recipe {
  readonly name: string;
  readonly file: string;
  readonly categories: readonly string[];
}

export interface CategoryGroup {
  readonly name: string;
  readonly slug: string;
  readonly recipes: readonly Recipe[];
}

export interface Grouped {
  readonly curated: readonly CategoryGroup[];
  readonly regular: readonly CategoryGroup[];
  readonly uncategorised: readonly Recipe[];
}

const NAME = /<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/i;
const CATEGORIES = /<p[^>]*itemprop="recipeCategory"[^>]*>([\s\S]*?)<\/p>/i;

/** Only the entities Paprika actually emits: &apos; &amp; &quot; &gt; &lt;. */
const decodeEntities = (text: string): string =>
  text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function parseRecipe(html: string, file: string): Recipe {
  const name = html.match(NAME);
  if (name === null) {
    throw new Error(`${file}: no <h1 itemprop="name"> — the export shape changed`);
  }

  const categories = html.match(CATEGORIES);
  return {
    name: decodeEntities(name[1].trim()),
    file,
    categories:
      categories === null
        ? []
        : decodeEntities(categories[1])
            .split(",")
            .map((c) => c.trim())
            .filter((c) => c !== ""),
  };
}

/**
 * Curation tags display without their leading underscore: "_Proven" reads
 * "Proven". The underscore stays in the source data — it is what distinguishes a
 * curation tag from a cuisine — so stripping it is a display concern only.
 * Because the character no longer carries the distinction visually, curated
 * chips get their own class and are sorted first explicitly.
 */
export const displayName = (category: string): string =>
  category.startsWith(CURATION_PREFIX) ? category.slice(CURATION_PREFIX.length) : category;

const isCurated = (category: string): boolean => category.startsWith(CURATION_PREFIX);

export const slugFor = (category: string): string =>
  category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const byName = (a: Recipe, b: Recipe): number => collator.compare(a.name, b.name);

export function group(recipes: readonly Recipe[]): Grouped {
  const buckets = new Map<string, Recipe[]>();
  const uncategorised: Recipe[] = [];

  for (const recipe of recipes) {
    if (recipe.categories.length === 0) {
      uncategorised.push(recipe);
      continue;
    }
    for (const category of recipe.categories) {
      const bucket = buckets.get(category);
      if (bucket === undefined) buckets.set(category, [recipe]);
      else bucket.push(recipe);
    }
  }

  const slugs = new Map<string, string>();
  const groups: CategoryGroup[] = [];
  for (const [name, members] of buckets) {
    const slug = slugFor(name);
    const claimed = slugs.get(slug);
    if (claimed !== undefined) {
      throw new Error(
        `categories "${claimed}" and "${name}" collide on the anchor "#${slug}"`,
      );
    }
    slugs.set(slug, name);
    groups.push({ name, slug, recipes: [...members].sort(byName) });
  }

  // Largest first: the big categories are the useful ways in, and the long tail
  // (6 categories hold a single recipe) sinks to the bottom where it belongs.
  const bySize = (a: CategoryGroup, b: CategoryGroup): number =>
    b.recipes.length - a.recipes.length || collator.compare(a.name, b.name);

  return {
    curated: groups.filter((g) => g.name.startsWith(CURATION_PREFIX)).sort(bySize),
    regular: groups.filter((g) => !g.name.startsWith(CURATION_PREFIX)).sort(bySize),
    uncategorised: [...uncategorised].sort(byName),
  };
}

const href = (recipe: Recipe, prefix: string): string =>
  `${prefix}Recipes/${encodeURIComponent(recipe.file)}`;

/** Curation tags lead, then cuisines alphabetically — explicit, not incidental. */
const chipOrder = (a: string, b: string): number =>
  Number(isCurated(b)) - Number(isCurated(a)) || collator.compare(a, b);

const renderRecipe = (recipe: Recipe, prefix: string, context?: string): string => {
  const others = [...recipe.categories].filter((c) => c !== context).sort(chipOrder);
  const tags =
    others.length === 0
      ? ""
      : ` <span class="tags">${others
          .map(
            (c) =>
              `<span class="tag${isCurated(c) ? " curated" : ""}">${escapeHtml(displayName(c))}</span>`,
          )
          .join("")}</span>`;
  return `<li><a href="${href(recipe, prefix)}">${escapeHtml(recipe.name)}</a>${tags}</li>`;
};

const renderGroup = (g: CategoryGroup, open: boolean, items: string): string => `
<details id="${g.slug}"${open ? " open" : ""}>
  <summary>${escapeHtml(displayName(g.name))} <span class="count">${g.recipes.length}</span></summary>
  <ul>${items}</ul>
</details>`;

const STYLE = `
:root { color-scheme: light dark; --fg: #34302e; --bg: #fff; --muted: #6b6764;
  --line: #e2ded9; --link: #1a5fb4; --accent: #c1121f; --chip: #f2efec; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e8e3dd; --bg: #16140f; --muted: #a8a099; --line: #322e28;
    --link: #8ab4f8; --accent: #ff6b6b; --chip: #24211c; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 1rem 1rem 4rem; font: 1rem/1.5 -apple-system, BlinkMacSystemFont,
  "Segoe UI", Helvetica, sans-serif; color: var(--fg); background: var(--bg);
  max-width: 46rem; margin-inline: auto; -webkit-text-size-adjust: 100%; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
.counts { color: var(--muted); margin: 0 0 1rem; font-size: .875rem; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
#filter { width: 100%; padding: .7rem .9rem; font-size: 1rem; border: 1px solid var(--line);
  border-radius: .5rem; background: var(--bg); color: var(--fg); margin-bottom: 1rem; }
h2 { font-size: .8125rem; text-transform: uppercase; letter-spacing: .06em;
  color: var(--accent); margin: 2rem 0 .5rem; padding-bottom: .3rem;
  border-bottom: 1px solid var(--line); }
h2 .note { text-transform: none; letter-spacing: 0; color: var(--muted);
  font-weight: normal; }
details { border-bottom: 1px solid var(--line); }
summary { padding: .75rem .25rem; cursor: pointer; font-weight: 600;
  display: flex; justify-content: space-between; gap: .5rem; align-items: baseline; }
summary::-webkit-details-marker { display: none; }
.count { color: var(--muted); font-weight: normal; font-size: .875rem; }
ul { list-style: none; margin: 0 0 .75rem; padding: 0; }
li { padding: .5rem .25rem; border-top: 1px solid var(--line); }
li a { display: inline-block; min-height: 1.5rem; }
.tags { display: inline-flex; flex-wrap: wrap; gap: .25rem; margin-left: .35rem;
  vertical-align: middle; }
.tag { font-size: .6875rem; color: var(--muted); background: var(--chip);
  padding: .1rem .4rem; border-radius: .75rem; white-space: nowrap; }
.tag.curated { color: var(--accent); background: transparent;
  box-shadow: inset 0 0 0 1px currentColor; }
.empty { color: var(--muted); font-style: italic; padding: 1rem .25rem; }
footer { margin-top: 3rem; color: var(--muted); font-size: .8125rem; }
`;

// Progressive enhancement: without JS every recipe is still listed and linked.
const SCRIPT = `
const q = document.getElementById('filter');
const items = [...document.querySelectorAll('li[data-n]')];
const blocks = [...document.querySelectorAll('details, section')];
const note = document.getElementById('noresults');
q.addEventListener('input', () => {
  const term = q.value.trim().toLowerCase();
  for (const li of items) {
    li.hidden = term !== '' && !li.dataset.n.includes(term);
  }
  for (const b of blocks) {
    const list = b.querySelectorAll('li[data-n]');
    const shown = [...list].filter(li => !li.hidden).length;
    b.hidden = list.length > 0 && shown === 0;
    if (term !== '' && b.tagName === 'DETAILS' && shown > 0) b.open = true;
  }
  note.hidden = term === '' || items.some(li => !li.hidden);
});
`;

/**
 * Renders the README's prose for the page footer, so the repository's own
 * description stays reachable now that the index has replaced it as the landing
 * page. Handles only what the README actually contains: paragraphs and inline
 * `[text](url)` links. The H1 is dropped (the page has its own) and so is the
 * sentence pointing at the index, which would now point at itself.
 */
export function renderReadme(markdown: string): string {
  return markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "" && !block.startsWith("#"))
    .filter((block) => !block.includes("paprika-export/index.html"))
    .map((block) => {
      const parts: string[] = [];
      let at = 0;
      for (const link of block.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
        parts.push(escapeHtml(block.slice(at, link.index)));
        parts.push(`<a href="${escapeHtml(link[2])}">${escapeHtml(link[1])}</a>`);
        at = link.index + link[0].length;
      }
      parts.push(escapeHtml(block.slice(at)));
      return `<p>${parts.join("").replace(/\n/g, " ")}</p>`;
    })
    .join("\n");
}

export interface RenderOptions {
  /** Prepended to every recipe href, e.g. "paprika-export/" at the site root. */
  readonly linkPrefix?: string;
  /** README markdown, folded into the footer. */
  readonly readme?: string;
}

export function renderIndex(
  recipes: readonly Recipe[],
  options: RenderOptions = {},
): string {
  const prefix = options.linkPrefix ?? "";
  const g = group(recipes);
  const categorised = recipes.length - g.uncategorised.length;
  const categoryCount = g.curated.length + g.regular.length;

  // data-n carries the searchable text: recipe name plus its categories, so
  // filtering on "swiss" finds recipes even from the flat A-Z list.
  const withSearchData = (html: string, r: Recipe): string =>
    html.replace(
      "<li>",
      `<li data-n="${escapeHtml([r.name, ...r.categories].join(" ").toLowerCase())}">`,
    );

  const list = (rs: readonly Recipe[], context?: string): string =>
    rs.map((r) => withSearchData(renderRecipe(r, prefix, context), r)).join("");

  const groupHtml = (gr: CategoryGroup, open: boolean): string =>
    renderGroup(gr, open, list(gr.recipes, gr.name));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recipes (${recipes.length})</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Recipes</h1>
<p class="counts">${recipes.length} recipes · ${categorised} across ${categoryCount} categories · ${g.uncategorised.length} uncategorised</p>

<input type="search" id="filter" placeholder="Filter by name or category…" autocomplete="off">
<p class="empty" id="noresults" hidden>Nothing matches that.</p>

<section id="collections">
<h2>Collections</h2>
${g.curated.map((gr) => groupHtml(gr, gr.name === "_Proven")).join("\n")}
</section>

<section id="categories">
<h2>Categories <span class="note">— ${categorised} of ${recipes.length} recipes are categorised</span></h2>
${g.regular.map((gr) => groupHtml(gr, false)).join("\n")}
</section>

<section id="uncategorised">
<h2>Uncategorised <span class="note">— ${g.uncategorised.length} recipes carry no category</span></h2>
<ul>${list(g.uncategorised)}</ul>
</section>

<section id="all">
<h2>All recipes <span class="note">— A to Z</span></h2>
<ul>${list([...recipes].sort(byName))}</ul>
</section>

<footer>
${options.readme === undefined ? "" : renderReadme(options.readme)}
<p>This index is generated from the export by the Pages workflow.</p>
</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

export interface IndexTarget extends RenderOptions {
  /** Where to write, relative to the site root. */
  readonly path: string;
}

const DEFAULT_TARGETS: readonly IndexTarget[] = [
  { path: join("paprika-export", "index.html"), linkPrefix: "" },
];

/** Reads every recipe page under the built site and writes the index page(s). */
export async function buildIndex(
  siteRoot: string,
  targets: readonly IndexTarget[] = DEFAULT_TARGETS,
): Promise<{ recipes: number }> {
  const recipesDir = join(siteRoot, "paprika-export", "Recipes");
  const recipes: Recipe[] = [];

  for await (const rel of relativeFilesUnder(recipesDir)) {
    // Only the recipe pages themselves: Images/ and Resources/ live below this.
    if (!isHtml(rel) || rel.includes("/")) continue;
    recipes.push(parseRecipe(await readFile(join(recipesDir, rel), "utf8"), rel));
  }

  if (recipes.length === 0) {
    throw new Error(`no recipe pages found under ${recipesDir}`);
  }

  for (const target of targets) {
    await writeFile(join(siteRoot, target.path), renderIndex(recipes, target), "utf8");
  }
  return { recipes: recipes.length };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { recipes } = await buildIndex(process.argv[2] ?? "_site");
  console.log(`index: built from ${recipes} recipe page(s)`);
}
