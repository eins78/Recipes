/**
 * Generates recipes.json — a machine-readable export of the whole collection,
 * published alongside the generated index so a consumer (a Slack bot doing
 * meal planning) can fetch one small file instead of scraping 247 HTML pages.
 *
 * Sibling of build-index.ts: same schema.org microdata, same walk, same
 * entity decoding. This tool goes deeper per recipe (ingredients, directions,
 * timing, source) but stays out of build-index.ts's way — it writes its own
 * file and never touches paprika-export/ or the generated index pages.
 *
 * Images are never emitted: being small is the point of this file. Nutrition
 * and rating are also omitted — they add bulk with no meal-planning value.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { decodeEntities, parseRecipe } from "./build-index.ts";
import { isHtml, relativeFilesUnder } from "./walk.ts";

const execFileAsync = promisify(execFile);

export interface RecipeDetail {
  readonly id: string;
  readonly name: string;
  readonly categories: readonly string[];
  readonly description?: string;
  readonly ingredients: readonly string[];
  readonly directions: readonly string[];
  readonly notes?: string;
  readonly yield?: string;
  readonly prepTime?: string;
  readonly cookTime?: string;
  readonly totalTime?: string;
  readonly difficulty?: string;
  readonly source?: string;
  readonly sourceUrl?: string;
}

export interface Provenance {
  /** Full SHA of the last commit that touched paprika-export/. */
  readonly exportCommit: string;
  /** That commit's author date, ISO 8601 — the load-bearing field: Max
   *  re-exports from Paprika by hand, so this can be months older than
   *  `generated`. */
  readonly exportDate: string;
}

export interface RecipesFile extends Provenance {
  readonly generated: string;
  readonly count: number;
  readonly recipes: readonly RecipeDetail[];
}

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, "");

/** <br/> becomes a newline before tags are stripped, so line breaks survive. */
const cleanText = (html: string): string =>
  decodeEntities(stripTags(html.replace(/<br\s*\/?>/gi, "\n")))
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

const undefinedIfEmpty = (text: string): string | undefined => (text === "" ? undefined : text);

/**
 * Ingredient lines are flat: <p class="line" itemprop="recipeIngredient"> wraps
 * the whole line, with the quantity nested inside a <strong>. A regex that
 * stops at the first "</" returns only that nested quantity — this is the
 * export's one real parsing trap. Matching non-greedily up to the *ingredient
 * line's own* closing </p> (not the first tag close of any kind) avoids it.
 */
const INGREDIENT = /<p class="line" itemprop="recipeIngredient">([\s\S]*?)<\/p>/g;

const extractIngredients = (html: string): string[] =>
  [...html.matchAll(INGREDIENT)].map((m) => cleanText(m[1])).filter((s) => s !== "");

/** Matches a schema.org container whose content is confirmed div-free, so a
 *  non-greedy capture up to the *first* closing tag is safe. */
const container = (tag: string, itemprop: string): RegExp =>
  new RegExp(`<${tag}[^>]*itemprop="${itemprop}"[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");

const extractContainer = (html: string, tag: string, itemprop: string): string | undefined => {
  const match = html.match(container(tag, itemprop));
  return match === null ? undefined : match[1];
};

/** Splits a container's markup into paragraphs — every <p>, whether or not it
 *  carries class="line" (two recipes use bare <p> for directions). */
const paragraphsOf = (blockHtml: string): string[] =>
  [...blockHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => cleanText(m[1]))
    .filter((p) => p !== "");

/** Directions and description/notes share a container-then-split shape, but
 *  directions stay an array of steps while description/notes read as prose. */
const extractSteps = (html: string, tag: string, itemprop: string): string[] => {
  const block = extractContainer(html, tag, itemprop);
  return block === undefined ? [] : paragraphsOf(block);
};

const extractProse = (html: string, tag: string, itemprop: string): string | undefined => {
  const block = extractContainer(html, tag, itemprop);
  if (block === undefined) return undefined;
  const paragraphs = paragraphsOf(block);
  return undefinedIfEmpty(paragraphs.length > 0 ? paragraphs.join("\n\n") : cleanText(block));
};

const extractScalar = (html: string, itemprop: string): string | undefined => {
  const match = html.match(new RegExp(`<span[^>]*itemprop="${itemprop}"[^>]*>([\\s\\S]*?)<\\/span>`, "i"));
  return match === null ? undefined : undefinedIfEmpty(cleanText(match[1]));
};

/** author and url always co-occur in the export (229/229): one match reads
 *  both the visible source name and the href it links to. */
const SOURCE = /<a itemprop="url" href="([^"]*)">\s*<span itemprop="author">([\s\S]*?)<\/span>/i;

const extractSource = (html: string): Pick<RecipeDetail, "source" | "sourceUrl"> => {
  const match = html.match(SOURCE);
  if (match === null) return {};
  return { source: undefinedIfEmpty(cleanText(match[2])), sourceUrl: decodeEntities(match[1]) };
};

/** id is the export filename without ".html" — stable across builds, unique
 *  by construction (Paprika filenames the export after each recipe), and the
 *  same key verify-site.ts already uses for its own set-equality checks. */
const idFor = (file: string): string => file.replace(/\.html?$/i, "");

export function parseRecipeDetail(html: string, file: string): RecipeDetail {
  const { name, categories } = parseRecipe(html, file);
  const { source, sourceUrl } = extractSource(html);

  return {
    id: idFor(file),
    name,
    categories,
    description: extractProse(html, "div", "description"),
    ingredients: extractIngredients(html),
    directions: extractSteps(html, "div", "recipeInstructions"),
    notes: extractProse(html, "div", "comment"),
    yield: extractScalar(html, "recipeYield"),
    prepTime: extractScalar(html, "prepTime"),
    cookTime: extractScalar(html, "cookTime"),
    totalTime: extractScalar(html, "totalTime"),
    difficulty: extractScalar(html, "difficulty"),
    source,
    sourceUrl,
  };
}

/** Reads every recipe page under the built site and writes recipes.json at
 *  the site root. Provenance is a parameter, not derived here, so tests never
 *  shell out to git. */
export async function buildRecipesJson(
  siteRoot: string,
  provenance: Provenance,
): Promise<{ recipes: number }> {
  const recipesDir = join(siteRoot, "paprika-export", "Recipes");
  const recipes: RecipeDetail[] = [];

  for await (const rel of relativeFilesUnder(recipesDir)) {
    // Only the recipe pages themselves: Images/ and Resources/ live below this.
    if (!isHtml(rel) || rel.includes("/")) continue;
    recipes.push(parseRecipeDetail(await readFile(join(recipesDir, rel), "utf8"), rel));
  }

  if (recipes.length === 0) {
    throw new Error(`no recipe pages found under ${recipesDir}`);
  }

  // Sorted by id for a deterministic file — directory listings are not
  // guaranteed stable across platforms, and a stable order keeps diffs small
  // between exports.
  recipes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const file: RecipesFile = {
    generated: new Date().toISOString(),
    exportCommit: provenance.exportCommit,
    exportDate: provenance.exportDate,
    count: recipes.length,
    recipes,
  };

  await writeFile(join(siteRoot, "recipes.json"), JSON.stringify(file), "utf8");
  return { recipes: recipes.length };
}

/** Resolves provenance from git history: the last commit that touched
 *  paprika-export/, not the current HEAD — Max re-exports by hand, so the two
 *  routinely diverge. Requires full history (the workflow sets
 *  fetch-depth: 0); a shallow clone would find nothing and this throws rather
 *  than silently falling back to build time. */
async function resolveProvenance(repoRoot: string): Promise<Provenance> {
  const { stdout } = await execFileAsync(
    "git",
    ["log", "-1", "--format=%H%x1f%aI", "--", "paprika-export"],
    { cwd: repoRoot },
  );
  const [exportCommit, exportDate] = stdout.trim().split("\x1f");
  if (exportCommit === undefined || exportDate === undefined || exportCommit === "") {
    throw new Error(
      "could not resolve the last commit touching paprika-export/ — " +
        "is this a shallow clone? the workflow needs fetch-depth: 0",
    );
  }
  return { exportCommit, exportDate };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const repoRoot = process.argv[2] ?? ".";
  const siteRoot = process.argv[3] ?? "_site";
  const provenance = await resolveProvenance(repoRoot);
  const { recipes } = await buildRecipesJson(siteRoot, provenance);
  console.log(`recipes.json: built from ${recipes} recipe page(s), export ${provenance.exportCommit.slice(0, 7)}`);
}
