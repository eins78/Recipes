import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifySite } from "./verify-site.ts";

const HEBREW_RECIPE = "Grilled Eggplant Salad (‎חצילים ‎סלט).html";

const PAGE_WITH_VIEWPORT =
  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="UTF-8"></head><body>x</body></html>';

/** A generated index must link every recipe page. */
const indexLinking = (files: readonly string[], prefix = ""): string =>
  `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><ul>${files
    .map((f) => `<li><a href="${prefix}Recipes/${encodeURIComponent(f)}">${f}</a></li>`)
    .join("")}</ul></body></html>`;
const PAGE_WITHOUT_VIEWPORT = "<html><head><meta charset=\"UTF-8\"></head><body>x</body></html>";

const EXPORT_COMMIT = "a".repeat(40);

/** A recipes.json matching the two fixture recipes, which carry no
 *  itemprop="recipeIngredient" — neither has ingredients, in the HTML or here. */
const validRecipesJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    generated: "2026-09-12T00:00:00.000Z",
    exportCommit: EXPORT_COMMIT,
    exportDate: "2026-08-15T22:34:47+02:00",
    count: 2,
    recipes: [
      { id: "Älplermagronen", name: "Älplermagronen", categories: [], ingredients: [], directions: [] },
      {
        id: HEBREW_RECIPE.replace(/\.html?$/i, ""),
        name: HEBREW_RECIPE.replace(/\.html?$/i, ""),
        categories: [],
        ingredients: [],
        directions: [],
      },
    ],
    ...overrides,
  });

/**
 * Builds a repo + a matching built site. Returns both roots.
 * The site is what the workflow would produce: same tree, viewport injected.
 */
async function makePair(): Promise<{ repoRoot: string; siteRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), "verify-site-"));
  const repoRoot = join(base, "repo");
  const siteRoot = join(base, "_site");

  for (const root of [repoRoot, siteRoot]) {
    await mkdir(join(root, "paprika-export", "Recipes", "Images", "abc"), { recursive: true });
    await writeFile(join(root, "paprika-export", "index.html"), PAGE_WITH_VIEWPORT);
    await writeFile(join(root, "paprika-export", "Recipes", "Älplermagronen.html"), PAGE_WITH_VIEWPORT);
    await writeFile(join(root, "paprika-export", "Recipes", HEBREW_RECIPE), PAGE_WITH_VIEWPORT);
    await writeFile(join(root, "paprika-export", "Recipes", "Images", "abc", "1.jpg"), "jpeg");
    await writeFile(join(root, "paprika-export", "Recipes", "Images", "abc", "2.jpg"), "jpeg");
  }
  // The repo's own copies are the pristine export, without a viewport.
  await writeFile(join(repoRoot, "paprika-export", "index.html"), PAGE_WITHOUT_VIEWPORT);
  // The built indexes are the generated ones, linking every recipe: one at the
  // site root and one at the in-the-wild paprika-export/index.html URL.
  const all = ["Älplermagronen.html", HEBREW_RECIPE];
  await writeFile(join(siteRoot, "paprika-export", "index.html"), indexLinking(all));
  await writeFile(join(siteRoot, "index.html"), indexLinking(all, "paprika-export/"));
  await writeFile(join(siteRoot, "recipes.json"), validRecipesJson());

  return { repoRoot, siteRoot };
}

const canaries = [
  "paprika-export/index.html",
  "paprika-export/Recipes/Älplermagronen.html",
  `paprika-export/Recipes/${HEBREW_RECIPE}`,
];

describe("verifySite", () => {
  test("passes on a correctly built site and reports what it checked", async () => {
    const { repoRoot, siteRoot } = await makePair();

    const report = await verifySite({ repoRoot, siteRoot, canaries });

    assert.equal(report.htmlChecked, 4);
    assert.equal(report.images, 2);
    assert.equal(report.recipesJson, 2);
  });

  test("fails when a recipe page is missing from the built site", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await rm(join(siteRoot, "paprika-export", "Recipes", "Älplermagronen.html"));

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /missing from the built site[\s\S]*Älplermagronen/,
    );
  });

  test("fails when the built site has a page the export does not", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(join(siteRoot, "paprika-export", "Recipes", "Ghost.html"), PAGE_WITH_VIEWPORT);

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /not in the export[\s\S]*Ghost\.html/,
    );
  });

  test("fails when a built page carries no viewport meta", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(
      join(siteRoot, "paprika-export", "Recipes", "Älplermagronen.html"),
      PAGE_WITHOUT_VIEWPORT,
    );

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /viewport[\s\S]*Älplermagronen/,
    );
  });

  test("fails when a built page carries a duplicated viewport meta", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(
      join(siteRoot, "paprika-export", "Recipes", "Älplermagronen.html"),
      PAGE_WITH_VIEWPORT.replace("<head>", `<head><meta name="viewport" content="x">`),
    );

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /viewport[\s\S]*Älplermagronen/,
    );
  });

  test("fails when images went missing", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await rm(join(siteRoot, "paprika-export", "Recipes", "Images", "abc", "2.jpg"));

    await assert.rejects(() => verifySite({ repoRoot, siteRoot, canaries }), /image/i);
  });

  test("fails when a canary path is absent", async () => {
    const { repoRoot, siteRoot } = await makePair();

    await assert.rejects(
      () =>
        verifySite({
          repoRoot,
          siteRoot,
          canaries: [...canaries, "paprika-export/Recipes/Never Existed.html"],
        }),
      /Never Existed/,
    );
  });

  test("fails when the generated index does not link every recipe", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(
      join(siteRoot, "paprika-export", "index.html"),
      indexLinking([HEBREW_RECIPE]), // Älplermagronen dropped
    );

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /index[\s\S]*Älplermagronen/,
    );
  });

  test("fails when the root landing page does not link every recipe", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(
      join(siteRoot, "index.html"),
      indexLinking([HEBREW_RECIPE], "paprika-export/"), // Älplermagronen dropped
    );

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /index\.html[\s\S]*Älplermagronen/,
    );
  });

  test("accepts an index whose hrefs are percent-encoded", async () => {
    const { repoRoot, siteRoot } = await makePair();

    const report = await verifySite({ repoRoot, siteRoot, canaries });

    assert.equal(report.htmlChecked, 4);
  });

  test("reports every problem at once, not just the first", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await rm(join(siteRoot, "paprika-export", "Recipes", "Älplermagronen.html"));
    await rm(join(siteRoot, "paprika-export", "Recipes", "Images", "abc", "2.jpg"));

    const error = await verifySite({ repoRoot, siteRoot, canaries }).catch((e: Error) => e);

    assert.match(error.message, /Älplermagronen/);
    assert.match(error.message, /image/i);
  });
});

describe("verifySite — recipes.json", () => {
  test("fails when recipes.json is missing", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await rm(join(siteRoot, "recipes.json"));

    await assert.rejects(() => verifySite({ repoRoot, siteRoot, canaries }), /recipes\.json is missing/);
  });

  test("fails when recipes.json is not valid JSON", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(join(siteRoot, "recipes.json"), "{ not json");

    await assert.rejects(() => verifySite({ repoRoot, siteRoot, canaries }), /not valid JSON/);
  });

  test("fails when count does not match the recipes array", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(join(siteRoot, "recipes.json"), validRecipesJson({ count: 99 }));

    await assert.rejects(() => verifySite({ repoRoot, siteRoot, canaries }), /count \(99\)/);
  });

  test("fails when recipes.json is missing a recipe present in the built site", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(
      join(siteRoot, "recipes.json"),
      validRecipesJson({
        count: 1,
        recipes: [
          { id: "Älplermagronen", name: "x", categories: [], ingredients: [], directions: [] },
        ],
      }),
    );

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /missing from recipes\.json/,
    );
  });

  test("fails when recipes.json has an id with no matching recipe page", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(
      join(siteRoot, "recipes.json"),
      validRecipesJson({
        count: 3,
        recipes: [
          { id: "Älplermagronen", name: "x", categories: [], ingredients: [], directions: [] },
          {
            id: HEBREW_RECIPE.replace(/\.html?$/i, ""),
            name: "x",
            categories: [],
            ingredients: [],
            directions: [],
          },
          { id: "Ghost", name: "x", categories: [], ingredients: [], directions: [] },
        ],
      }),
    );

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /no matching recipe page[\s\S]*Ghost/,
    );
  });

  test("fails when recipes.json has duplicate ids", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(
      join(siteRoot, "recipes.json"),
      validRecipesJson({
        count: 2,
        recipes: [
          { id: "Älplermagronen", name: "x", categories: [], ingredients: [], directions: [] },
          { id: "Älplermagronen", name: "x", categories: [], ingredients: [], directions: [] },
        ],
      }),
    );

    await assert.rejects(() => verifySite({ repoRoot, siteRoot, canaries }), /duplicate id/);
  });

  test("does not object when a recipe genuinely has no ingredients in the HTML", async () => {
    // Both fixture recipes carry no itemprop="recipeIngredient" at all, and
    // validRecipesJson() correctly reports ingredients: [] for both — this
    // must pass, matching verify-site's existing refusal to require ingredients.
    const { repoRoot, siteRoot } = await makePair();

    await assert.doesNotReject(() => verifySite({ repoRoot, siteRoot, canaries }));
  });

  test("fails when recipes.json claims ingredients the HTML doesn't have", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(
      join(siteRoot, "recipes.json"),
      validRecipesJson({
        recipes: [
          {
            id: "Älplermagronen",
            name: "x",
            categories: [],
            ingredients: ["1 cup flour"],
            directions: [],
          },
          {
            id: HEBREW_RECIPE.replace(/\.html?$/i, ""),
            name: "x",
            categories: [],
            ingredients: [],
            directions: [],
          },
        ],
      }),
    );

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /no ingredients in the HTML but recipes\.json claims some/,
    );
  });

  test("fails when the parser regresses to capturing only the nested quantity", async () => {
    const { repoRoot, siteRoot } = await makePair();
    // Simulates the brief's named trap: a naive first-"</" match yields only
    // the <strong>-wrapped amount for nearly every ingredient.
    const quantityOnly = ["1", "1 3/4", "1 1/2", "2", "1/4", "1/2", "2/3"];
    await writeFile(
      join(siteRoot, "recipes.json"),
      validRecipesJson({
        recipes: [
          {
            id: "Älplermagronen",
            name: "x",
            categories: [],
            ingredients: quantityOnly,
            directions: [],
          },
          {
            id: HEBREW_RECIPE.replace(/\.html?$/i, ""),
            name: "x",
            categories: [],
            ingredients: [],
            directions: [],
          },
        ],
      }),
    );

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /quantity-only/,
    );
  });

  test("fails when exportCommit is not a full SHA", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(join(siteRoot, "recipes.json"), validRecipesJson({ exportCommit: "abc123" }));

    await assert.rejects(() => verifySite({ repoRoot, siteRoot, canaries }), /exportCommit/);
  });

  test("fails when exportDate does not parse as a date", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await writeFile(join(siteRoot, "recipes.json"), validRecipesJson({ exportDate: "not a date" }));

    await assert.rejects(() => verifySite({ repoRoot, siteRoot, canaries }), /exportDate/);
  });

  test("fails when recipes.json leaks image paths", async () => {
    const { repoRoot, siteRoot } = await makePair();
    const raw = validRecipesJson();
    const withImage = raw.replace(
      '"directions":[]}',
      '"directions":[],"leaked":"Images/abc/1.jpg"}',
    );
    await writeFile(join(siteRoot, "recipes.json"), withImage);

    await assert.rejects(
      () => verifySite({ repoRoot, siteRoot, canaries }),
      /image paths or filenames/,
    );
  });
});
