import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSite } from "./build-site.ts";

const recipePage = (name: string, categories?: string): string =>
  `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<div class="recipe"><h1 itemprop="name" class="name">${name}</h1>
${categories === undefined ? "" : `<p itemprop="recipeCategory" class="categories">${categories}</p>`}
</div></body></html>`;

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "build-site-"));
  await mkdir(join(repo, "paprika-export", "Recipes", "Images", "x"), { recursive: true });
  await mkdir(join(repo, "paprika-export", "Recipes", "Resources"), { recursive: true });
  await writeFile(join(repo, "paprika-export", "index.html"), "<html><body>flat list</body></html>");
  await writeFile(
    join(repo, "paprika-export", "Recipes", "Älplermagronen.html"),
    recipePage("Älplermagronen", "_Proven, Swiss"),
  );
  await writeFile(
    join(repo, "paprika-export", "Recipes", "Gazpacho andaluz.html"),
    recipePage("Gazpacho andaluz"),
  );
  await writeFile(join(repo, "paprika-export", "Recipes", "Images", "x", "1.jpg"), "jpeg");
  await writeFile(join(repo, "paprika-export", "Recipes", "Resources", "app.css"), "body{}");
  await writeFile(join(repo, "README.md"), "# Recipes\n\nfrom [Paprika](https://p.test)\n");
  // Build tooling that must never reach the site.
  await mkdir(join(repo, "tools"), { recursive: true });
  await writeFile(join(repo, "tools", "build-site.ts"), "// code");
  await writeFile(join(repo, "package.json"), "{}");
  await mkdir(join(repo, "docs", "sessionlogs"), { recursive: true });
  await writeFile(join(repo, "docs", "sessionlogs", "log.md"), "# log");
  return repo;
}

describe("buildSite", () => {
  test("copies the export and writes both index pages", async () => {
    const repo = await makeRepo();
    const site = join(repo, "_site");

    const result = await buildSite(repo, site);

    assert.equal(result.recipes, 2);
    assert.ok(await readFile(join(site, "index.html"), "utf8"));
    assert.ok(await readFile(join(site, "paprika-export", "index.html"), "utf8"));
    assert.equal(
      await readFile(join(site, "paprika-export", "Recipes", "Images", "x", "1.jpg"), "utf8"),
      "jpeg",
    );
    assert.equal(
      await readFile(join(site, "paprika-export", "Recipes", "Resources", "app.css"), "utf8"),
      "body{}",
    );
  });

  test("the root index links into paprika-export, the inner one stays relative", async () => {
    const repo = await makeRepo();
    const site = join(repo, "_site");

    await buildSite(repo, site);

    const root = await readFile(join(site, "index.html"), "utf8");
    const inner = await readFile(join(site, "paprika-export", "index.html"), "utf8");
    assert.ok(root.includes('href="paprika-export/Recipes/'));
    assert.ok(inner.includes('href="Recipes/'));
    assert.ok(!inner.includes('href="paprika-export/Recipes/'));
  });

  test("never copies the build tooling into the site", async () => {
    const repo = await makeRepo();
    const site = join(repo, "_site");

    await buildSite(repo, site);

    for (const forbidden of ["tools", "package.json", "docs"]) {
      await assert.rejects(
        () => readFile(join(site, forbidden, "x"), "utf8"),
        `${forbidden} must not reach the site`,
      );
    }
  });

  test("folds the README prose into the generated page", async () => {
    const repo = await makeRepo();
    const site = join(repo, "_site");

    await buildSite(repo, site);

    const root = await readFile(join(site, "index.html"), "utf8");
    assert.ok(root.includes('<a href="https://p.test">Paprika</a>'));
  });

  test("leaves the source export untouched", async () => {
    const repo = await makeRepo();
    const site = join(repo, "_site");

    await buildSite(repo, site);

    assert.equal(
      await readFile(join(repo, "paprika-export", "index.html"), "utf8"),
      "<html><body>flat list</body></html>",
    );
  });

  test("fails loudly when there is no export to build from", async () => {
    const empty = await mkdtemp(join(tmpdir(), "build-site-empty-"));

    await assert.rejects(() => buildSite(empty, join(empty, "_site")), /paprika-export/);
  });

  test("is re-runnable over an existing output directory", async () => {
    const repo = await makeRepo();
    const site = join(repo, "_site");

    await buildSite(repo, site);
    const second = await buildSite(repo, site);

    assert.equal(second.recipes, 2);
  });
});
