/**
 * Injects a viewport meta tag into every HTML page of a built site.
 *
 * The Paprika export ships no viewport meta at all, so phones assume a ~980px
 * layout viewport and render every page zoomed out. This is the whole of the
 * mobile fix.
 *
 * Insertion is done on the raw string, deliberately — NOT by parsing and
 * re-serialising. The export contains unescaped `&` inside hrefs, curly quotes,
 * CJK/Hangul/Hebrew text and U+200E bidi marks. A DOM round-trip would silently
 * rewrite all of that; a string splice cannot.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isHtml, relativeFilesUnder } from "./walk.ts";

export const VIEWPORT_META =
  '<meta name="viewport" content="width=device-width, initial-scale=1">';

const HEAD_OPEN = /<head\b[^>]*>/i;
const EXISTING_VIEWPORT = /<meta[^>]+name\s*=\s*["']?viewport\b/i;

export type InjectionOutcome =
  | { readonly status: "injected"; readonly html: string }
  | { readonly status: "skipped"; readonly html: string };

export interface InjectionSummary {
  readonly injected: number;
  readonly skipped: number;
}

/** Pure string transform. Throws if there is no `<head>` to inject into. */
export function injectIntoHtml(html: string): InjectionOutcome {
  if (EXISTING_VIEWPORT.test(html)) {
    return { status: "skipped", html };
  }

  const headOpen = html.match(HEAD_OPEN);
  if (headOpen?.index === undefined) {
    throw new Error("no <head> element to inject into");
  }

  const at = headOpen.index + headOpen[0].length;
  return {
    status: "injected",
    html: html.slice(0, at) + VIEWPORT_META + html.slice(at),
  };
}

/** Rewrites every HTML file under `root` in place. Idempotent. */
export async function injectIntoDirectory(root: string): Promise<InjectionSummary> {
  let injected = 0;
  let skipped = 0;
  let seen = 0;

  for await (const rel of relativeFilesUnder(root)) {
    if (!isHtml(rel)) continue;
    seen += 1;

    const path = join(root, rel);
    const original = await readFile(path, "utf8");

    let outcome: InjectionOutcome;
    try {
      outcome = injectIntoHtml(original);
    } catch (cause) {
      // Name the file: a bare "no <head>" is useless across 248 pages.
      throw new Error(`${rel}: ${(cause as Error).message}`, { cause });
    }

    if (outcome.status === "skipped") {
      skipped += 1;
      continue;
    }

    // Belt and braces: the splice must add exactly the meta tag and nothing else.
    const delta =
      Buffer.byteLength(outcome.html, "utf8") - Buffer.byteLength(original, "utf8");
    const expected = Buffer.byteLength(VIEWPORT_META, "utf8");
    if (delta !== expected) {
      throw new Error(`${rel}: expected to add ${expected} bytes, added ${delta}`);
    }

    await writeFile(path, outcome.html, "utf8");
    injected += 1;
  }

  // Zero pages means the wrong directory was passed, or the build produced
  // nothing. Whether pages ended up *tagged* is verify-site's job, not this
  // one's — a future export that ships its own viewport meta is correct, not a
  // failure.
  if (seen === 0) {
    throw new Error(`no HTML files found under ${root}`);
  }

  return { injected, skipped };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const root = process.argv[2] ?? "_site";
  const { injected, skipped } = await injectIntoDirectory(root);
  console.log(
    `viewport: injected into ${injected} page(s), skipped ${skipped} already carrying one`,
  );
}
