// Loading fixtures from disk. The bundled set lives in packages/system-one-client/fixtures, one
// folder per provider.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fixture } from "./fixture.js";

/** The bundled fixtures folder (src/fixture and dist/fixture both sit two levels below the package). */
export const BUNDLED_FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/**
 * Every `*.json` fixture under `dir`, validated. Subfolders are read too unless `recursive` is false;
 * spec files under `specs/` are always skipped.
 */
export function loadFixturesFromDir(dir: string, opts: { recursive?: boolean } = {}): Fixture[] {
  const out: Fixture[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "specs" && opts.recursive !== false) out.push(...loadFixturesFromDir(path, opts));
      continue;
    }
    if (!entry.endsWith(".json")) continue;
    const parsed = Fixture.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error(`invalid fixture ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    out.push(parsed.data);
  }
  return out;
}

/** The fixtures that ship with this package. */
export function loadBundledFixtures(): Fixture[] {
  return loadFixturesFromDir(BUNDLED_FIXTURES_DIR);
}

/**
 * The fixtures directly in one provider's folder, without its model folders (fixtures/<provider>/<model>/).
 * These are the requests `pnpm fixtures:record` re-sends.
 */
export function loadProviderFixtures(provider: string): Fixture[] {
  return loadFixturesFromDir(join(BUNDLED_FIXTURES_DIR, provider), { recursive: false });
}
