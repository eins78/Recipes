import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRecipe,
  group,
  slugFor,
  renderIndex,
  displayName,
  renderReadme,
  CURATION_PREFIX,
} from "./build-index.ts";

const page = (opts: { name: string; categories?: string }): string => `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<div class="recipe" itemscope itemtype="http://schema.org/Recipe">
  <div class="infobox">
    <h1 itemprop="name" class="name">${opts.name}</h1>
    <p itemprop="aggregateRating" class="rating" value="0"></p>
    ${opts.categories === undefined ? "" : `<p itemprop="recipeCategory" class="categories">${opts.categories}</p>`}
  </div>
</div></body></html>`;

const recipe = (name: string, categories: string[] = []) => ({
  name,
  file: `${name}.html`,
  categories,
});

describe("parseRecipe", () => {
  test("extracts the name and decodes HTML entities", () => {
    const r = parseRecipe(page({ name: "Warm Black Lentils &amp; Tomato" }), "x.html");

    assert.equal(r.name, "Warm Black Lentils & Tomato");
  });

  test("decodes the entity set the export actually uses", () => {
    const r = parseRecipe(
      page({ name: "&quot;Watermelon Tuna&quot; &apos;n &gt; &lt; &amp;" }),
      "x.html",
    );

    assert.equal(r.name, `"Watermelon Tuna" 'n > < &`);
  });

  test("keeps non-ASCII and bidi marks in the name intact", () => {
    const r = parseRecipe(page({ name: "Grilled Eggplant Salad (‎חצילים ‎סלט)" }), "x.html");

    assert.equal(r.name, "Grilled Eggplant Salad (‎חצילים ‎סלט)");
  });

  test("splits a comma-joined category list and trims each", () => {
    const r = parseRecipe(
      page({ name: "Älplermagronen", categories: "_Proven, Fall/Winter, Soul Food, Swiss" }),
      "x.html",
    );

    assert.deepEqual(r.categories, ["_Proven", "Fall/Winter", "Soul Food", "Swiss"]);
  });

  test("returns no categories when the element is absent — 129 recipes are like this", () => {
    const r = parseRecipe(page({ name: "Gazpacho andaluz" }), "x.html");

    assert.deepEqual(r.categories, []);
  });

  test("preserves category names verbatim, typos included", () => {
    const r = parseRecipe(
      page({ name: "x", categories: "Mediterrean, Maroccan, Easter-European" }),
      "x.html",
    );

    assert.deepEqual(r.categories, ["Mediterrean", "Maroccan", "Easter-European"]);
  });

  test("throws when there is no recipe name, naming the file", () => {
    assert.throws(
      () => parseRecipe("<html><body>no h1</body></html>", "Broken Recipe.html"),
      /Broken Recipe\.html/,
    );
  });
});

describe("slugFor", () => {
  test("makes URL-safe anchors", () => {
    assert.equal(slugFor("Fall/Winter"), "fall-winter");
    assert.equal(slugFor("Gluten-Free"), "gluten-free");
    assert.equal(slugFor("_Proven"), "proven");
  });

  test("keeps Side and Side Dishes distinct — they are separate categories in the data", () => {
    assert.notEqual(slugFor("Side"), slugFor("Side Dishes"));
  });
});

describe("group", () => {
  test("puts a multi-category recipe in every list it belongs to", () => {
    const r = recipe("Älplermagronen", ["_Proven", "Swiss", "Soul Food"]);

    const g = group([r]);

    const names = [...g.curated, ...g.regular].map((c) => c.name).sort();
    assert.deepEqual(names, ["Soul Food", "Swiss", "_Proven"]);
    for (const c of [...g.curated, ...g.regular]) {
      assert.deepEqual(c.recipes.map((x) => x.name), ["Älplermagronen"]);
    }
  });

  test("separates curation tags from real categories", () => {
    const g = group([
      recipe("a", ["_Proven"]),
      recipe("b", ["_Mealprep"]),
      recipe("c", ["Italian"]),
    ]);

    assert.deepEqual(g.curated.map((c) => c.name), ["_Mealprep", "_Proven"]);
    assert.deepEqual(g.regular.map((c) => c.name), ["Italian"]);
    for (const c of g.curated) assert.ok(c.name.startsWith(CURATION_PREFIX));
  });

  test("collects recipes with no categories into their own bucket", () => {
    const g = group([recipe("uncat"), recipe("cat", ["Italian"])]);

    assert.deepEqual(g.uncategorised.map((r) => r.name), ["uncat"]);
  });

  test("sorts recipes within a category the way a reader expects", () => {
    const g = group([
      recipe("Apple Pie", ["X"]),
      recipe("Älplermagronen", ["X"]),
      recipe("Aloo Jeera", ["X"]),
    ]);

    assert.deepEqual(
      g.regular[0].recipes.map((r) => r.name),
      ["Aloo Jeera", "Älplermagronen", "Apple Pie"],
    );
  });

  test("orders categories by size, largest first", () => {
    const g = group([
      recipe("a", ["Small"]),
      recipe("b", ["Big"]),
      recipe("c", ["Big"]),
    ]);

    assert.deepEqual(g.regular.map((c) => c.name), ["Big", "Small"]);
  });

  test("throws if two categories collide on the same anchor", () => {
    assert.throws(() => group([recipe("a", ["A/B"]), recipe("b", ["A B"])]), /anchor/i);
  });
});

describe("renderIndex", () => {
  const recipes = [
    recipe("Älplermagronen", ["_Proven", "Swiss"]),
    recipe("Warm Black Lentils & Tomato", []),
    recipe("Grilled Eggplant Salad (‎חצילים ‎סלט)", ["Middle Eastern"]),
  ];

  test("URL-encodes hrefs so spaces, ampersands and bidi marks resolve", () => {
    const html = renderIndex(recipes);

    assert.ok(html.includes("Recipes/Warm%20Black%20Lentils%20%26%20Tomato.html"));
    assert.ok(html.includes("%E2%80%8E"));
    assert.ok(!html.includes('href="Recipes/Warm Black Lentils & Tomato.html"'));
  });

  test("escapes names in the visible text", () => {
    const html = renderIndex(recipes);

    assert.ok(html.includes("Warm Black Lentils &amp; Tomato"));
  });

  test("carries a viewport meta so the index is mobile-first like the recipe pages", () => {
    assert.match(renderIndex(recipes), /<meta name="viewport" content="width=device-width/);
  });

  test("states the uncategorised count instead of hiding it", () => {
    const html = renderIndex(recipes);

    assert.match(html, /1 uncategorised/i);
  });

  test("lists every recipe in the complete A-Z section", () => {
    const html = renderIndex(recipes);
    const all = html.slice(html.indexOf('id="all"'));

    for (const r of recipes) {
      assert.ok(all.includes(encodeURIComponent(r.file)), `${r.name} missing from A-Z`);
    }
  });

  test("shows a recipe's other categories alongside it", () => {
    const html = renderIndex([recipe("Multi", ["Italian", "Swiss"])]);

    assert.ok(html.includes("Italian"));
    assert.ok(html.includes("Swiss"));
  });

  test("produces no unsubstituted template markers", () => {
    assert.ok(!/\{\{|\$\{/.test(renderIndex(recipes)));
  });

  test("prefixes hrefs when rendered for the site root", () => {
    const html = renderIndex(recipes, { linkPrefix: "paprika-export/" });

    assert.ok(html.includes('href="paprika-export/Recipes/'));
    assert.ok(!html.includes('href="Recipes/'));
  });
});

describe("displayName", () => {
  test("drops the leading underscore from curation tags", () => {
    assert.equal(displayName("_Proven"), "Proven");
    assert.equal(displayName("_Mealprep"), "Mealprep");
    assert.equal(displayName("_Sourdough"), "Sourdough");
  });

  test("leaves ordinary categories alone", () => {
    assert.equal(displayName("Soul Food"), "Soul Food");
    assert.equal(displayName("Gluten-Free"), "Gluten-Free");
  });
});

describe("curation tags in the rendered page", () => {
  const recipes = [recipe("Älplermagronen", ["Swiss", "_Proven", "Fall/Winter"])];

  test("are shown without the underscore", () => {
    const html = renderIndex(recipes);

    assert.ok(html.includes(">Proven "), "summary should read Proven");
    assert.ok(!html.includes(">_Proven"), "no underscore should be displayed");
  });

  test("keep their underscore in the source data, which is what identifies them", () => {
    const g = group(recipes);

    assert.deepEqual(g.curated.map((c) => c.name), ["_Proven"]);
    assert.deepEqual(recipes[0].categories.includes("_Proven"), true);
  });

  test("are marked in the chips so the distinction survives losing the underscore", () => {
    const html = renderIndex(recipes);

    assert.match(html, /class="tag curated">Proven</);
    assert.match(html, /class="tag">Swiss</);
  });

  test("sort ahead of cuisines explicitly, not by the underscore's character order", () => {
    // Checked in the A-Z section, where nothing is the current context so every
    // category shows. "Fall/Winter" sorts before "Proven" alphabetically, so if
    // the chips came out alphabetically the curation tag would not lead.
    const all = renderIndex(recipes).split('id="all"')[1];
    const chips = [...all.matchAll(/class="tag(?: curated)?">([^<]+)</g)].map((m) => m[1]);

    assert.deepEqual(chips, ["Proven", "Fall/Winter", "Swiss"]);
  });
});

describe("renderReadme", () => {
  const README = `# Recipes

managed with/exported from [Paprika App](https://www.paprikaapp.com)

see [the index](https://code.178.is/Recipes/paprika-export/index.html)
`;

  test("renders the prose with its links intact", () => {
    const html = renderReadme(README);

    assert.ok(html.includes('<a href="https://www.paprikaapp.com">Paprika App</a>'));
    assert.ok(html.includes("managed with/exported from"));
  });

  test("drops the heading — the page already has one", () => {
    assert.ok(!renderReadme(README).includes("Recipes</h1>"));
  });

  test("drops the self-referential link to the index", () => {
    const html = renderReadme(README);

    assert.ok(!html.includes("paprika-export/index.html"), "should not link to itself");
    assert.ok(!html.includes("see "), "the whole sentence goes, not just the link");
  });

  test("escapes prose that is not a link", () => {
    assert.ok(renderReadme("a & b < c").includes("a &amp; b &lt; c"));
  });

  test("survives an empty readme", () => {
    assert.equal(renderReadme("").trim(), "");
  });
});
