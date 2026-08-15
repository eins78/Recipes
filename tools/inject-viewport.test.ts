import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VIEWPORT_META,
  injectIntoHtml,
  injectIntoDirectory,
} from "./inject-viewport.ts";

/** The exact <head> Paprika emits, byte-identical across all 247 recipe pages. */
const PAPRIKA_HEAD = `<!DOCTYPE html>
<html>
    <head>
        <meta charset="UTF-8">
        <style type="text/css">body { font-size: 16.0px; }</style>
    </head>
    <body><h1 itemprop="name" class="name">Älplermagronen</h1></body>
</html>
`;

describe("injectIntoHtml", () => {
  test("inserts the viewport meta immediately after the opening head tag", () => {
    const result = injectIntoHtml(PAPRIKA_HEAD);

    assert.equal(result.status, "injected");
    assert.ok(result.html.includes(`<head>${VIEWPORT_META}`));
  });

  test("adds exactly the bytes of the meta tag and changes nothing else", () => {
    const result = injectIntoHtml(PAPRIKA_HEAD);

    const before = Buffer.byteLength(PAPRIKA_HEAD, "utf8");
    const after = Buffer.byteLength(result.html, "utf8");
    assert.equal(after - before, Buffer.byteLength(VIEWPORT_META, "utf8"));
    assert.equal(result.html.replace(VIEWPORT_META, ""), PAPRIKA_HEAD);
  });

  test("leaves a page that already declares a viewport untouched", () => {
    const jekyllPage = `<html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Recipes</title>
  </head><body>README</body></html>`;

    const result = injectIntoHtml(jekyllPage);

    assert.equal(result.status, "skipped");
    assert.equal(result.html, jekyllPage);
  });

  test("is idempotent — injecting twice matches injecting once", () => {
    const once = injectIntoHtml(PAPRIKA_HEAD).html;
    const twice = injectIntoHtml(once).html;

    assert.equal(twice, once);
  });

  test("throws when the document has no head element", () => {
    assert.throws(
      () => injectIntoHtml("<html><body>no head here</body></html>"),
      /no <head>/i,
    );
  });

  test("preserves an unescaped ampersand in an href", () => {
    // 16 files in the export carry a raw & inside a query string. A parser
    // round-trip would rewrite these to &amp;; string insertion must not.
    const raw = `<html><head></head><body>
      <a href="https://x.test/i.jpg?_nc_cat=107&_nc_ohc=abc">photo</a>
      <li><a href="Recipes/Warm Black Lentils & Tomato.html">Warm Black Lentils &amp; Tomato</a></li>
    </body></html>`;

    const { html } = injectIntoHtml(raw);

    assert.ok(html.includes("?_nc_cat=107&_nc_ohc=abc"));
    assert.ok(html.includes('href="Recipes/Warm Black Lentils & Tomato.html"'));
  });

  test("preserves bidi control marks and non-ASCII body content byte-for-byte", () => {
    const raw =
      "<html><head></head><body>Grilled Eggplant Salad (‎חצילים ‎סלט) 麻酱芥辣凉面 Gauthier’s</body></html>";

    const { html } = injectIntoHtml(raw);

    assert.ok(html.includes("‎חצילים ‎סלט"));
    assert.ok(html.includes("麻酱芥辣凉面"));
    assert.ok(html.includes("Gauthier’s"));
  });

  test("handles an uppercase head tag and head tags with attributes", () => {
    assert.ok(
      injectIntoHtml("<HTML><HEAD></HEAD></HTML>").html.includes(`<HEAD>${VIEWPORT_META}`),
    );
    assert.ok(
      injectIntoHtml('<head lang="en"></head>').html.includes(`<head lang="en">${VIEWPORT_META}`),
    );
  });
});

describe("injectIntoDirectory", () => {
  async function makeSite(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "inject-viewport-"));
    await mkdir(join(dir, "paprika-export", "Recipes"), { recursive: true });
    await writeFile(join(dir, "paprika-export", "index.html"), PAPRIKA_HEAD);
    // A real filename from the export: two U+200E bidi marks.
    await writeFile(
      join(dir, "paprika-export", "Recipes", "Grilled Eggplant Salad (‎חצילים ‎סלט).html"),
      PAPRIKA_HEAD,
    );
    await writeFile(join(dir, "paprika-export", "Recipes", "Älplermagronen.html"), PAPRIKA_HEAD);
    await writeFile(
      join(dir, "index.html"),
      '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head></html>',
    );
    await writeFile(join(dir, "not-html.css"), "body { color: red }");
    return dir;
  }

  test("injects into every html file that needs it, recursively", async () => {
    const dir = await makeSite();

    const summary = await injectIntoDirectory(dir);

    assert.equal(summary.injected, 3);
    assert.equal(summary.skipped, 1);
    const recipe = await readFile(
      join(dir, "paprika-export", "Recipes", "Älplermagronen.html"),
      "utf8",
    );
    assert.ok(recipe.includes(VIEWPORT_META));
  });

  test("injects into a filename containing bidi control marks", async () => {
    const dir = await makeSite();

    await injectIntoDirectory(dir);

    const content = await readFile(
      join(dir, "paprika-export", "Recipes", "Grilled Eggplant Salad (‎חצילים ‎סלט).html"),
      "utf8",
    );
    assert.ok(content.includes(VIEWPORT_META));
  });

  test("leaves non-html files alone", async () => {
    const dir = await makeSite();

    await injectIntoDirectory(dir);

    assert.equal(await readFile(join(dir, "not-html.css"), "utf8"), "body { color: red }");
  });

  test("a second run changes nothing", async () => {
    const dir = await makeSite();

    await injectIntoDirectory(dir);
    const second = await injectIntoDirectory(dir);

    assert.equal(second.injected, 0);
    assert.equal(second.skipped, 4);
  });

  test("fails when the directory holds no HTML at all — the wrong path was passed", async () => {
    const empty = await mkdtemp(join(tmpdir(), "inject-viewport-empty-"));
    await writeFile(join(empty, "readme.txt"), "not html");

    await assert.rejects(() => injectIntoDirectory(empty), /no HTML/i);
  });

  test("fails loudly when a page has no head, naming the file", async () => {
    const dir = await makeSite();
    await writeFile(join(dir, "broken.html"), "<html><body>nope</body></html>");

    await assert.rejects(() => injectIntoDirectory(dir), /broken\.html/);
  });
});
