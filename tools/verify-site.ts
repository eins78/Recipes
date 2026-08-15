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
}

const countViewports = (html: string): number =>
  html.match(/<meta[^>]+name\s*=\s*["']?viewport\b/gi)?.length ?? 0;

const sorted = (values: Iterable<string>): string[] => [...values].sort();

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

  if (problems.length > 0) {
    throw new Error(`site verification failed:\n\n${problems.join("\n\n")}`);
  }

  return { htmlChecked: allHtml.length, images: siteImages };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const repoRoot = process.argv[2] ?? ".";
  const siteRoot = process.argv[3] ?? "_site";
  const report = await verifySite({ repoRoot, siteRoot });
  console.log(
    `verified: ${report.htmlChecked} page(s) each with one viewport meta, ${report.images} image(s) intact`,
  );
}
