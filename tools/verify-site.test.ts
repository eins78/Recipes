import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifySite } from "./verify-site.ts";

const HEBREW_RECIPE = "Grilled Eggplant Salad (‎חצילים ‎סלט).html";

const PAGE_WITH_VIEWPORT =
  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="UTF-8"></head><body>x</body></html>';
const PAGE_WITHOUT_VIEWPORT = "<html><head><meta charset=\"UTF-8\"></head><body>x</body></html>";

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

    assert.equal(report.htmlChecked, 3);
    assert.equal(report.images, 2);
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

  test("reports every problem at once, not just the first", async () => {
    const { repoRoot, siteRoot } = await makePair();
    await rm(join(siteRoot, "paprika-export", "Recipes", "Älplermagronen.html"));
    await rm(join(siteRoot, "paprika-export", "Recipes", "Images", "abc", "2.jpg"));

    const error = await verifySite({ repoRoot, siteRoot, canaries }).catch((e: Error) => e);

    assert.match(error.message, /Älplermagronen/);
    assert.match(error.message, /image/i);
  });
});
