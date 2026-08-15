/**
 * Assembles the published site from the export.
 *
 * This replaced Jekyll. Jekyll's only remaining job was turning README.md into
 * the landing page at /Recipes/; once the generated index took that slot, the
 * container step and the `sudo chown` that existed solely because
 * jekyll-build-pages runs as root had no reason to exist either.
 *
 * The copy is an allowlist — only paprika-export/ is copied — which is a safer
 * shape than Jekyll's `exclude:` denylist, where forgetting an entry published
 * build tooling.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildIndex } from "./build-index.ts";

const EXPORT_DIR = "paprika-export";

export interface SiteResult {
  readonly recipes: number;
}

export async function buildSite(repoRoot: string, siteRoot: string): Promise<SiteResult> {
  const source = join(repoRoot, EXPORT_DIR);
  try {
    await cp(source, join(siteRoot, EXPORT_DIR), { recursive: true, force: true });
  } catch (cause) {
    throw new Error(`could not copy ${EXPORT_DIR} from ${repoRoot}`, { cause });
  }

  const readme = await readFile(join(repoRoot, "README.md"), "utf8").catch(() => undefined);

  // The index is written twice: at the site root, which is the landing page, and
  // at paprika-export/index.html, whose URL is in the wild (the README linked it
  // and so did anyone who bookmarked it). Same content, different link depth.
  await mkdir(siteRoot, { recursive: true });
  const { recipes } = await buildIndex(siteRoot, [
    { path: "index.html", linkPrefix: `${EXPORT_DIR}/`, readme },
    { path: join(EXPORT_DIR, "index.html"), linkPrefix: "", readme },
  ]);

  return { recipes };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { recipes } = await buildSite(process.argv[2] ?? ".", process.argv[3] ?? "_site");
  console.log(`site: assembled from ${recipes} recipe page(s)`);
}
