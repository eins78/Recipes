/**
 * Post-build assertions on the generated site.
 *
 * These exist so that a change in Paprika's export shape, or a builder bug,
 * fails the workflow loudly instead of quietly deploying a half-built site.
 * Because Pages deploys are artifact-based, a failure here leaves the currently
 * published site untouched.
 *
 * Deliberately NOT asserted: presence of ingredients, instructions, source,
 * yield or categories. Those are genuinely absent from some recipes (2, 2, 18,
 * 63 and 129 files respectively at the time of writing) — real gaps in the
 * library, not parse failures.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fileSet, isHtml, isJpeg } from "./walk.ts";

const EXPORT_DIR = "paprika-export";

/** Real paths from the export, chosen to break if URL/unicode handling regresses. */
export const DEFAULT_CANARIES: readonly string[] = [
  "paprika-export/index.html",
  "paprika-export/Recipes/Älplermagronen.html",
  // Contains two U+200E LEFT-TO-RIGHT MARK characters.
  "paprika-export/Recipes/Grilled Eggplant Salad (‎חצילים ‎סלט).html",
];

export interface VerifyOptions {
  readonly repoRoot: string;
  readonly siteRoot: string;
  readonly canaries?: readonly string[];
}

export interface VerifyReport {
  readonly htmlChecked: number;
  readonly images: number;
  readonly recipesJson: number;
}

const countViewports = (html: string): number =>
  html.match(/<meta[^>]+name\s*=\s*["']?viewport\b/gi)?.length ?? 0;

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** A shallow shape check: the fields recipes.json's own build gate must not
 *  silently drop. Deliberately not a full schema — that lives with the parser. */
interface RecipeDetailShape {
  readonly id: string;
  readonly ingredients: readonly string[];
}

interface RecipesFileShape {
  readonly generated: string;
  readonly exportCommit: string;
  readonly exportDate: string;
  readonly count: number;
  readonly recipes: readonly RecipeDetailShape[];
}

const PURE_QUANTITY = /^[\d\s./-]+$/;
const EXPORT_COMMIT = /^[0-9a-f]{40}$/;

export async function verifySite(options: VerifyOptions): Promise<VerifyReport> {
  const { repoRoot, siteRoot, canaries = DEFAULT_CANARIES } = options;
  const problems: string[] = [];

  const exportFiles = await fileSet(join(repoRoot, EXPORT_DIR));
  const siteExportFiles = await fileSet(join(siteRoot, EXPORT_DIR));
  const siteFiles = await fileSet(siteRoot);

  if (siteExportFiles.size === 0) {
    throw new Error(
      `nothing found under ${join(siteRoot, EXPORT_DIR)} — the build produced no site`,
    );
  }

  // 1. Set equality of pages, both directions. A count comparison would let a
  //    dropped page hide behind an added one.
  const exportHtml = new Set(sorted(exportFiles).filter(isHtml));
  const siteHtml = new Set(sorted(siteExportFiles).filter(isHtml));

  const missing = sorted(exportHtml).filter((f) => !siteHtml.has(f));
  if (missing.length > 0) {
    problems.push(
      `${missing.length} page(s) missing from the built site:\n  ${missing.join("\n  ")}`,
    );
  }

  const extra = sorted(siteHtml).filter((f) => !exportHtml.has(f));
  if (extra.length > 0) {
    problems.push(
      `${extra.length} page(s) in the built site that are not in the export:\n  ${extra.join("\n  ")}`,
    );
  }

  // 2. Every page in the whole site carries exactly one viewport meta.
  const allHtml = sorted(siteFiles).filter(isHtml);
  const wrongViewport: string[] = [];
  for (const rel of allHtml) {
    const count = countViewports(await readFile(join(siteRoot, rel), "utf8"));
    if (count !== 1) wrongViewport.push(`${rel} (${count})`);
  }
  if (wrongViewport.length > 0) {
    problems.push(
      `${wrongViewport.length} page(s) without exactly one viewport meta:\n  ${wrongViewport.join("\n  ")}`,
    );
  }

  // 3. Every photo survived the copy.
  const exportImages = sorted(exportFiles).filter(isJpeg).length;
  const siteImages = sorted(siteExportFiles).filter(isJpeg).length;
  if (exportImages !== siteImages) {
    problems.push(`image count differs: export has ${exportImages}, site has ${siteImages}`);
  }

  // 4. Both generated index pages reach every recipe: the landing page at the
  //    site root and the in-the-wild paprika-export/index.html. Without this, a
  //    parser change could quietly ship an index listing half the library.
  const recipeFiles = sorted(exportHtml)
    .filter((f) => f.startsWith("Recipes/"))
    .map((f) => f.slice("Recipes/".length))
    .filter((f) => !f.includes("/"));

  for (const [page, prefix] of [
    ["index.html", `${EXPORT_DIR}/`],
    [join(EXPORT_DIR, "index.html"), ""],
  ] as const) {
    const html = await readFile(join(siteRoot, page), "utf8").catch(() => null);
    if (html === null) {
      problems.push(`${page} is missing from the built site`);
      continue;
    }
    const pattern = new RegExp(`href="${prefix}Recipes/([^"]+)"`, "g");
    const linked = new Set(
      [...html.matchAll(pattern)].map((m) => decodeURIComponent(m[1]).normalize("NFC")),
    );
    const unlinked = recipeFiles.filter((f) => !linked.has(f));
    if (unlinked.length > 0) {
      problems.push(
        `${unlinked.length} recipe(s) not linked from ${page}:\n  ${unlinked.join("\n  ")}`,
      );
    }
  }

  // 5. Canary paths — unicode and bidi marks made it through intact.
  const absentCanaries = canaries
    .map((c) => c.normalize("NFC"))
    .filter((c) => !siteFiles.has(c));
  if (absentCanaries.length > 0) {
    problems.push(`canary path(s) absent from the site:\n  ${absentCanaries.join("\n  ")}`);
  }

  // 6. recipes.json — the machine-readable export Tachikoma reads. A count is
  //    not pinned here: Max re-exports by hand and the corpus grows between
  //    exports, so the gate checks shape and set-consistency, not a number.
  const recipesJsonRaw = await readFile(join(siteRoot, "recipes.json"), "utf8").catch(() => null);
  let recipesJsonCount = 0;

  if (recipesJsonRaw === null) {
    problems.push("recipes.json is missing from the built site");
  } else {
    let parsed: RecipesFileShape | undefined;
    try {
      parsed = JSON.parse(recipesJsonRaw) as RecipesFileShape;
    } catch (cause) {
      problems.push(`recipes.json is not valid JSON: ${(cause as Error).message}`);
    }

    if (parsed !== undefined) {
      recipesJsonCount = parsed.count;

      if (parsed.count !== parsed.recipes.length) {
        problems.push(
          `recipes.json count (${parsed.count}) does not match its recipes array (${parsed.recipes.length})`,
        );
      }

      // Set equality against the recipe pages actually in the site, both
      // directions — same style as check 1, and it catches a parser that
      // silently drops or duplicates a recipe even when the count matches.
      const jsonIds = new Set(parsed.recipes.map((r) => r.id));
      if (jsonIds.size !== parsed.recipes.length) {
        problems.push(
          `recipes.json has ${parsed.recipes.length - jsonIds.size} duplicate id(s)`,
        );
      }
      const htmlIds = new Set(recipeFiles.map((f) => f.replace(/\.html?$/i, "")));

      const missingFromJson = sorted(htmlIds).filter((id) => !jsonIds.has(id));
      if (missingFromJson.length > 0) {
        problems.push(
          `${missingFromJson.length} recipe(s) missing from recipes.json:\n  ${missingFromJson.join("\n  ")}`,
        );
      }
      const extraInJson = sorted(jsonIds).filter((id) => !htmlIds.has(id));
      if (extraInJson.length > 0) {
        problems.push(
          `${extraInJson.length} id(s) in recipes.json with no matching recipe page:\n  ${extraInJson.join("\n  ")}`,
        );
      }

      // Recipes genuinely without ingredients exist in the source data (see
      // header comment) — the gate does not forbid them. It instead demands
      // that recipes.json agree with the built HTML about *which* recipes
      // those are, so a parser bug that drops ingredients it shouldn't still
      // gets caught.
      const expectedEmpty = new Set<string>();
      // Only pages actually present in the built site: a missing page is
      // already reported by check 1, and re-reading it here would throw
      // ENOENT before every problem has had a chance to be collected.
      for (const f of recipeFiles.filter((r) => siteHtml.has(`Recipes/${r}`))) {
        const html = await readFile(join(siteRoot, EXPORT_DIR, "Recipes", f), "utf8");
        if (!html.includes('itemprop="recipeIngredient"')) {
          expectedEmpty.add(f.replace(/\.html?$/i, ""));
        }
      }
      const actualEmpty = new Set(
        parsed.recipes.filter((r) => r.ingredients.length === 0).map((r) => r.id),
      );
      const shouldHaveIngredients = sorted(actualEmpty).filter((id) => !expectedEmpty.has(id));
      if (shouldHaveIngredients.length > 0) {
        problems.push(
          `${shouldHaveIngredients.length} recipe(s) have ingredients in the HTML but not in recipes.json:\n  ${shouldHaveIngredients.join("\n  ")}`,
        );
      }
      const shouldBeEmpty = sorted(expectedEmpty).filter((id) => !actualEmpty.has(id));
      if (shouldBeEmpty.length > 0) {
        problems.push(
          `${shouldBeEmpty.length} recipe(s) have no ingredients in the HTML but recipes.json claims some:\n  ${shouldBeEmpty.join("\n  ")}`,
        );
      }

      // The brief's named trap: a regex that stops at the first "</" returns
      // only the <strong>-wrapped quantity ("1", "1 3/4", …) instead of the
      // ingredient line. That failure mode makes nearly every ingredient
      // string pure digits/fractions/whitespace; the correct parse makes none.
      const allIngredients = parsed.recipes.flatMap((r) => r.ingredients);
      if (allIngredients.length > 0) {
        const quantityOnly = allIngredients.filter((i) => PURE_QUANTITY.test(i));
        const ratio = quantityOnly.length / allIngredients.length;
        if (ratio > 0.05) {
          problems.push(
            `${quantityOnly.length} of ${allIngredients.length} ingredient strings ` +
              `(${(ratio * 100).toFixed(0)}%) are quantity-only — the parser likely ` +
              `regressed to capturing only the nested <strong> amount`,
          );
        }
      }

      if (!EXPORT_COMMIT.test(parsed.exportCommit)) {
        problems.push(`recipes.json exportCommit is not a full SHA: "${parsed.exportCommit}"`);
      }
      if (Number.isNaN(Date.parse(parsed.exportDate))) {
        problems.push(`recipes.json exportDate does not parse as a date: "${parsed.exportDate}"`);
      }
      if (Number.isNaN(Date.parse(parsed.generated))) {
        problems.push(`recipes.json generated does not parse as a date: "${parsed.generated}"`);
      }
    }

    // Image data must never leak into this file — being small is the point.
    if (/Images\//.test(recipesJsonRaw) || /\.jpe?g/i.test(recipesJsonRaw)) {
      problems.push("recipes.json appears to contain image paths or filenames");
    }
  }

  if (problems.length > 0) {
    throw new Error(`site verification failed:\n\n${problems.join("\n\n")}`);
  }

  return { htmlChecked: allHtml.length, images: siteImages, recipesJson: recipesJsonCount };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const repoRoot = process.argv[2] ?? ".";
  const siteRoot = process.argv[3] ?? "_site";
  const report = await verifySite({ repoRoot, siteRoot });
  console.log(
    `verified: ${report.htmlChecked} page(s) each with one viewport meta, ${report.images} image(s) intact, recipes.json holds ${report.recipesJson} recipe(s)`,
  );
}
