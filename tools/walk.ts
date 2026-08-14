import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Yields every file under `root` as a POSIX-style path relative to `root`.
 *
 * Paths are normalised to NFC. The export contains umlauts, CJK, Hangul, Hebrew
 * and U+200E bidi marks; comparing a macOS listing against a Linux one without
 * normalising is a silent source of phantom mismatches.
 */
export async function* relativeFilesUnder(
  root: string,
  prefix = "",
): AsyncGenerator<string> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* relativeFilesUnder(root, rel);
    } else {
      yield rel.normalize("NFC");
    }
  }
}

export const isHtml = (path: string): boolean => /\.html?$/i.test(path);

export const isJpeg = (path: string): boolean => /\.jpe?g$/i.test(path);

/** Collects `relativeFilesUnder` into a Set, or an empty Set if `root` is absent. */
export async function fileSet(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  try {
    for await (const rel of relativeFilesUnder(root)) found.add(rel);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return found;
}
