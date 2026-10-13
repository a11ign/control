// The control slice of fleet-layer/entry-points.test.ts (a11ign/a11ign#5345). The guard FORM and the symlink-blind ratchet are core's and are
// pinned in packages/guards/src/entry-points.test.ts (#5348); the fleet's own slice is a11ign/a11ign#5358. What is left is the one question only
// control can answer: every script control's own `package.json` runs does nothing when it is merely IMPORTED.
//
// It lives in `scripts/`, not `src/`, because it READS the `scripts` of `package.json`, and `src/` tests run LAID in the core, whose manifest for
// this package has `scripts` deleted (`ci.yml`, "Lay this repository's package": `jq 'del(.version, .scripts, ...)'`). Run 38342634783 read
// `pkg.scripts` as undefined there. `scripts/control-commands.test.ts` is held here for the same reason.
//
// Why it matters here: `node -e "import('./src/x.ts')"` is the only real check that a control module still loads, and an entry point that runs
// on import turns that check into a fleet command (`fleet-playbook.ts` imported without the guard would start an ansible run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** This repository's root, where `package.json` still has its `scripts`. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Measured 2026-10-13: 11 entry points. Two below it, so a moved layout fails here rather than shrinking the population quietly. */
const ENTRY_POINT_FLOOR = 9;

/** Every `src/*.ts` file an npm script runs, discovered from `package.json` so a new command is covered the day it is added. */
function npmScriptEntryPoints(): string[] {
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { scripts: Record<string, string> };
  const found = new Set<string>();
  for (const command of Object.values(pkg.scripts)) {
    for (const match of command.matchAll(/(?:^|\s)(src\/[^\s]+\.ts)/g)) {
      if (!match[1].endsWith(".test.ts")) found.add(match[1]);
    }
  }
  return [...found].sort();
}

/** `//` and `/* *\/` comments removed: a guard quoted in prose is not a guard. Enough for this predicate, which looks for one comparison. */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The plain form every control command uses; comments stripped first, because a file that only MENTIONS the guard has not got one. */
const refusesToRunWhenImported = (source: string): boolean => stripComments(source).includes("import.meta.url ===");

test("control's entry points are discovered, so the guard below cannot pass having read nothing", () => {
  const points = npmScriptEntryPoints();
  assert.ok(points.length >= ENTRY_POINT_FLOOR,
    `only ${points.length} entry points found in package.json; the discovery is broken, not the package clean`);
  assert.deepEqual(points.filter((path) => !existsSync(`${ROOT}${path}`)), [],
    "a package.json script names a src file that does not exist");
  assert.ok(points.includes("src/fleet-playbook.ts"), "the deploy command is the entry point this guard exists for");
});

test("every control npm entry point refuses to run when imported", () => {
  const unguarded = npmScriptEntryPoints().filter((path) => !refusesToRunWhenImported(readFileSync(`${ROOT}${path}`, "utf8")));
  assert.deepEqual(unguarded, [],
    "these run on import, so `node -e \"import(...)\"` cannot be used to check they still load. Wrap the executable part in a function and "
    + "call it only under `if (import.meta.url === pathToFileURL(process.argv[1] ?? \"\").href)`.");
});

test("the predicate tells a guard from a mention of one and from none", () => {
  // The positive control for the emptiness assertion above: a predicate that accepts everything makes `unguarded` empty for the wrong reason.
  const guarded = 'if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();';
  assert.equal(refusesToRunWhenImported(guarded), true);
  assert.equal(refusesToRunWhenImported(`// ${guarded}\nawait main();`), false, "a guard quoted in a comment is a mention, not a use");
  assert.equal(refusesToRunWhenImported("await main();"), false);
});

test("control declares no bin, so the plain (symlink-blind) guard form is the right one here", () => {
  // npm's own `.bin` entries are symlinks, and `import.meta.url === argv[1]` is false through one. Control is run as `node src/x.ts`; the day
  // it publishes a bin, each bin's guard has to realpath `argv[1]` as core's does (packages/guards/src/entry-points.test.ts).
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { bin?: unknown };
  assert.equal(pkg.bin, undefined, "control now declares a bin: its entry guard must survive being reached through a symlink");
});
