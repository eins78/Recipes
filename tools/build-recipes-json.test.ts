import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRecipeDetail, buildRecipesJson } from "./build-recipes-json.ts";

const page = (opts: {
  name: string;
  categories?: string;
  ingredients?: string[]; // raw inner HTML of each <p class="line" itemprop="recipeIngredient">
  instructions?: string; // raw inner HTML of the recipeInstructions <div>
  description?: string; // raw inner HTML of the description <div>
  notes?: string; // raw inner HTML of the comment <div>
  yield?: string;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  difficulty?: string;
  source?: string;
  sourceUrl?: string;
}): string => `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<div class="recipe" itemscope itemtype="http://schema.org/Recipe">
  <div class="infobox">
    <h1 itemprop="name" class="name">${opts.name}</h1>
    <p itemprop="aggregateRating" class="rating" value="0"></p>
    ${opts.categories === undefined ? "" : `<p itemprop="recipeCategory" class="categories">${opts.categories}</p>`}
    <p class="metadata">
      ${opts.prepTime === undefined ? "" : `<b>Prep Time: </b><span itemprop="prepTime">${opts.prepTime}</span>`}
      ${opts.cookTime === undefined ? "" : `<b>Cook Time: </b><span itemprop="cookTime">${opts.cookTime}</span>`}
      ${opts.totalTime === undefined ? "" : `<span itemprop="totalTime">${opts.totalTime}</span>`}
      ${opts.yield === undefined ? "" : `<b>Servings: </b><span itemprop="recipeYield">${opts.yield}</span>`}
      ${opts.difficulty === undefined ? "" : `<span itemprop="difficulty">${opts.difficulty}</span>`}
      ${
        opts.source === undefined
          ? ""
          : `<b>Source: </b><a itemprop="url" href="${opts.sourceUrl ?? ""}"><span itemprop="author">${opts.source}</span></a>`
      }
    </p>
  </div>
  ${
    opts.description === undefined
      ? ""
      : `<div itemprop="description" class="description text">${opts.description}</div>`
  }
  <div class="ingredientsbox">
    <div class="ingredients text">${(opts.ingredients ?? [])
      .map((i) => `<p class="line" itemprop="recipeIngredient">${i}</p>`)
      .join("")}</div>
  </div>
  ${
    opts.instructions === undefined
      ? ""
      : `<div itemprop="recipeInstructions" class="directions text">${opts.instructions}</div>`
  }
  ${opts.notes === undefined ? "" : `<div itemprop="comment" class="notes text">${opts.notes}</div>`}
</div></body></html>`;

describe("parseRecipeDetail", () => {
  test("extracts the ingredient text, not just the nested quantity", () => {
    // The trap: a naive regex that stops at the first "</" returns only the
    // <strong>-wrapped quantity, because the amount is nested inside the
    // ingredient line, not the whole line's text.
    const r = parseRecipeDetail(
      page({
        name: "x",
        ingredients: ["<strong>1 3/4</strong> cups water &amp; salt"],
      }),
      "x.html",
    );

    assert.deepEqual(r.ingredients, ["1 3/4 cups water & salt"]);
  });

  test("never yields a pure-quantity ingredient string across a representative sample", () => {
    const fixtures = [
      "<strong>1</strong> cup brown basmati rice",
      "<strong>1 1/2</strong> tablespoons olive oil",
      "<strong>2</strong> acorn squash, medium, halved",
      "<strong>1/4</strong> teaspoon garlic, minced",
      '<strong>1</strong> <a href="Sushi Rice.html">sushi rice</a>, prepared',
    ];
    const r = parseRecipeDetail(page({ name: "x", ingredients: fixtures }), "x.html");

    assert.equal(r.ingredients.length, fixtures.length);
    for (const ingredient of r.ingredients) {
      assert.doesNotMatch(ingredient, /^[\d\s./-]+$/, `"${ingredient}" is quantity-only`);
    }
  });

  test("splits directions into steps on paragraph boundaries, including a bare <p>", () => {
    const r = parseRecipeDetail(
      page({
        name: "x",
        instructions:
          '<p class="line">Boil the rice.</p><p>Season with salt &amp; pepper.</p>',
      }),
      "x.html",
    );

    assert.deepEqual(r.directions, ["Boil the rice.", "Season with salt & pepper."]);
  });

  test("turns <br/> within a step into a newline", () => {
    const r = parseRecipeDetail(
      page({ name: "x", instructions: '<p class="line">Line one.<br/>Line two.</p>' }),
      "x.html",
    );

    assert.deepEqual(r.directions, ["Line one.\nLine two."]);
  });

  test("joins multi-paragraph description and notes with a blank line", () => {
    const r = parseRecipeDetail(
      page({
        name: "x",
        description: "<p>First.</p><p>Second.</p>",
        notes: "<p>A note.<br/>More note.</p>",
      }),
      "x.html",
    );

    assert.equal(r.description, "First.\n\nSecond.");
    assert.equal(r.notes, "A note.\nMore note.");
  });

  test("reads source and sourceUrl from the author/url pairing", () => {
    const r = parseRecipeDetail(
      page({ name: "x", source: "walnuts.org", sourceUrl: "https://walnuts.org/recipe/1" }),
      "x.html",
    );

    assert.equal(r.source, "walnuts.org");
    assert.equal(r.sourceUrl, "https://walnuts.org/recipe/1");
  });

  test("omits optional fields entirely when the export carries none of them", () => {
    const r = parseRecipeDetail(page({ name: "Gazpacho andaluz" }), "x.html");

    assert.equal(r.description, undefined);
    assert.equal(r.notes, undefined);
    assert.equal(r.yield, undefined);
    assert.equal(r.prepTime, undefined);
    assert.equal(r.cookTime, undefined);
    assert.equal(r.totalTime, undefined);
    assert.equal(r.difficulty, undefined);
    assert.equal(r.source, undefined);
    assert.equal(r.sourceUrl, undefined);
    assert.deepEqual(r.ingredients, []);
    assert.deepEqual(r.directions, []);
  });

  test("parses cleanly when a recipe genuinely has no ingredients or instructions", () => {
    // Two real recipes in the corpus have no ingredients, two have no
    // instructions — not parse failures, gaps in the source data.
    const r = parseRecipeDetail(page({ name: "Dumpling Soup" }), "Dumpling Soup.html");

    assert.deepEqual(r.ingredients, []);
    assert.deepEqual(r.directions, []);
  });

  test("derives a stable id from the filename, dropping the .html extension", () => {
    const r = parseRecipeDetail(page({ name: "x" }), "Älplermagronen.html");

    assert.equal(r.id, "Älplermagronen");
  });

  test("never emits image data — the file must stay small", () => {
    const html = page({ name: "x" }).replace(
      "<body>",
      '<body><img src="Images/foo.jpg" itemprop="image"/>',
    );
    const r = parseRecipeDetail(html, "x.html");

    const serialised = JSON.stringify(r);
    assert.doesNotMatch(serialised, /\.jpe?g/i);
    assert.doesNotMatch(serialised, /Images\//);
  });

  test("decodes entities and keeps categories, reusing parseRecipe's own rules", () => {
    const r = parseRecipeDetail(
      page({ name: "Warm Lentils &amp; Tomato", categories: "_Proven, Swiss" }),
      "x.html",
    );

    assert.equal(r.name, "Warm Lentils & Tomato");
    assert.deepEqual(r.categories, ["_Proven", "Swiss"]);
  });
});

describe("buildRecipesJson", () => {
  test("writes recipes.json with provenance and a count matching the input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recipes-json-"));
    try {
      const recipesDir = join(dir, "paprika-export", "Recipes");
      await mkdir(recipesDir, { recursive: true });
      await writeFile(
        join(recipesDir, "One.html"),
        page({ name: "One", ingredients: ["<strong>1</strong> egg"] }),
        "utf8",
      );
      await writeFile(join(recipesDir, "Two.html"), page({ name: "Two" }), "utf8");

      const { recipes } = await buildRecipesJson(dir, {
        exportCommit: "a".repeat(40),
        exportDate: "2026-08-15T22:34:47+02:00",
      });
      assert.equal(recipes, 2);

      const written = JSON.parse(await readFile(join(dir, "recipes.json"), "utf8"));
      assert.equal(written.count, 2);
      assert.equal(written.recipes.length, 2);
      assert.equal(written.exportCommit, "a".repeat(40));
      assert.equal(written.exportDate, "2026-08-15T22:34:47+02:00");
      assert.ok(!Number.isNaN(Date.parse(written.generated)));
      assert.deepEqual(
        written.recipes.map((r: { id: string }) => r.id).sort(),
        ["One", "Two"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when no recipe pages are found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recipes-json-empty-"));
    try {
      await mkdir(join(dir, "paprika-export", "Recipes"), { recursive: true });
      await assert.rejects(() =>
        buildRecipesJson(dir, { exportCommit: "a".repeat(40), exportDate: "2026-01-01T00:00:00Z" }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
