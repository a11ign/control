// The control half of fleet-layer/protocol-guard.test.ts (a11ign/a11ign#5345): the deploy-client discovery reads control's `fleet-playbook.ts`.
// The `protocolVerdict`/`RECAPTURE_COST` unit tests moved to a11ign/screenreader-fleet (src/protocol-guard.test.ts, #5350).

/**
 * The deploy guard that stops a CAPTURE_PROTOCOL_VERSION change invalidating the capture cache unnoticed.
 *
 * It exists because the guard that WAS written reached only `worker:deploy` — `utmctl file push` against a
 * VM UUID, which cannot reach a bare-metal worker and fails off macOS. Every box in `inventory.yml` is bare
 * metal, so the one live deploy path was the unguarded one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { declareTreeWideGuard, walkTree } from "@a11ign/toolchain/lib/tree-wide-guard";
import { filesUnder } from "../../../guards/src/files-under.ts";

// #716/#704: this file's own population is the whole tracked tree, not one file -- declared here
// rather than inferred from its source, per ceo's ruling (2026-09-09) that the tree-wide-guard
// population must be derived from a real import, never from scanning source text.
declareTreeWideGuard();

/**
 * The fleet's sources as the layer checkout lays them. `walkTree` reads `git ls-files`, and the checkout at
 * `packages/worker-fleet/src` is untracked (the package lives in a11ign/screenreader-fleet), so the tracked walk alone
 * would not see the UTM deploy client at all. Deduplicated against the tracked walk by the caller, so a tree
 * that does track it counts each file once.
 */
function layerCheckoutSources(root: string): string[] {
  const dir = resolve(root, "packages/worker-fleet/src");
  if (!existsSync(dir)) return [];
  return filesUnder(dir, { skipDirectory: (name) => name === "node_modules" || name === "dist" })
    .filter((file) => /\.(?:ts|mjs)$/.test(file))
    .map((file) => relative(root, file));
}

/**
 * DISCOVERY: every path that SHIPS worker code must consult the guard.
 *
 * The reason this is a test rather than a comment: the guard WAS written, in `deploy-worker.mjs`, and that
 * script is `utmctl file push` keyed on a VM UUID — it cannot reach a bare-metal worker and exits
 * immediately off macOS. Every box in `inventory.yml` is bare metal. So for as long as the fleet has been
 * real, the guarded path was the dead one and the live path had no check at all.
 *
 * SHIPPING is the test, not MENTIONING. The first classifier matched any file naming `deploy.yml` and
 * flagged four that only quote it in advice strings — `worker-code-check` telling you to run
 * `fleet:deploy`, `fleet-env` explaining why `worker:deploy` cannot reach a physical box. That is the
 * "expectations derived from source TEXT" defect, which this repo has recorded twice: a regex scrape that
 * matched nothing and asserted over an empty set, and a `sweepLog` guard that read a shape nobody
 * verified. Comments are stripped, and the signature is the ACT of deploying.
 */
function deployClients(): { file: string; guarded: boolean }[] {
  const root = resolve(import.meta.dirname, "../../../..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...new Set([...walkTree({ kind: "both", roots: ["packages"] }).map((f) => f.path), ...layerCheckoutSources(root)])]
    .filter((f) => !f.includes(".test.") && !f.includes("/dist/"))
    .map((file) => ({ file, source: strip(readFileSync(resolve(root, file), "utf8")) }))
    // Two real shapes, and both must be here: Ansible running deploy.yml (bare metal, the live path) and
    // `utmctl file push` of WORKER_FILES (the UTM path, gone from the fleet package since 0.4.0 but kept as a shape, so one that returns is found).
    .filter(({ source }) => (source.includes("ansible-playbook") && source.includes("deploy.yml"))
      || (/"file",\s*"push"/.test(source) && source.includes("WORKER_FILES")))
        // THE CALL, not the name and not the import — and both refinements came from mutation, neither from
    // reading. A bare substring let `protocolVerdictXX` pass, because it contains `protocolVerdict`. Then
    // a word boundary still let a DELETED guard pass, because the `import` line survived the deletion and
    // matched. An import is not a guard. A test that cannot see its own subject being disabled is the
    // `refreshBrowseBuffer` defect one level out: green, and vouching for nothing.
    .map(({ file, source }) => ({ file,
      guarded: /\bprotocolVerdict\s*\(/.test(source) || /--allow-protocol-change/.test(source) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

test("DISCOVERY: every path that ships worker code guards CAPTURE_PROTOCOL_VERSION", () => {
  const clients = deployClients();
  assert.ok(clients.length >= 1, "the discovery found fewer than the one known deploy client, so its "
    + `classifier has stopped matching and it is examining nothing: ${JSON.stringify(clients)}`);
  assert.deepEqual(clients.filter((c) => !c.guarded).map((c) => c.file), [],
    "a path that ships worker code must check CAPTURE_PROTOCOL_VERSION against what the fleet serves — "
    + "shipping a change to it invalidates every cached capture");
});

test("the deploy path is found, so it cannot go unguarded unnoticed", () => {
  // Named explicitly because the lesson was that the UTM deploy path was guarded and the live one was not. The UTM path left
  // with `a11ign-worker-deploy` (screenreader-fleet 0.4.0, #3803), so what is left to find is the bare-metal one, and a classifier
  // that silently stopped matching it would make this file pass having checked nothing.
  const found = deployClients().map((c) => c.file);
  assert.ok(found.includes("packages/control/src/fleet-playbook.ts"),
    `the bare-metal path (the only live one) must be discovered; found ${JSON.stringify(found)}`);
});

/** Whether a fleet source names the protocol version at all -- see the two tests below for why that is the condition. */
const readsProtocolVersion = (source: string): boolean => source.includes("CAPTURE_PROTOCOL_VERSION");

/**
 * THE WORKING-TREE VALUE IS IMPORTED, NOT REGEX-SCRAPED — architecture-audit.md §5, item 3.
 *
 * `CAPTURE_PROTOCOL_VERSION` moved out of `capture-core.mjs` into its own dependency-free
 * `protocol-version.mjs`, precisely so a WORKER-FLEET script (which already depends on
 * `@a11ign/screenreader-worker`) can import the number directly instead of parsing it out of a file it
 * cannot safely import wholesale. A scraper whose regex or target path has quietly drifted reports the
 * OLD number as though nothing changed — this has teeth now that the value has actually moved once
 * (14 -> 15). The git-HEAD half of each guard still has to scrape TEXT (`git show` returns historical
 * bytes, not a loadable module), so only the working-tree half is asserted here.
 */
test("check-worker-code IMPORTS the working-tree protocol version", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  for (const file of ["packages/worker-fleet/src/check-worker-code.ts"]) {
    const source = readFileSync(resolve(root, file), "utf8");
    // The fleet repo's `check-worker-code.mjs` no longer carries `protocolBumpNote` (it was dropped there, after this
    // guard was written), so it reads no protocol version at all; a file that does not read one has nothing to import.
    if (readsProtocolVersion(source)) assert.match(source, /from\s+["']@a11ign\/screenreader-worker\/protocol-version["']/,
      `${file} must import CAPTURE_PROTOCOL_VERSION from the dependency-free protocol-version module`);
    assert.doesNotMatch(source, /readFileSync\([^)]*capture-core\.mjs/,
      `${file} still reads capture-core.mjs's TEXT for the working-tree value -- the whole point of the `
      + "move was to stop doing that");
  }
});

/**
 * THE HEAD-COMPARISON HALF NOW SCRAPES THE RIGHT FILE.
 *
 * Both guards ALSO compare against `git show HEAD:...` for a second reason (detecting an uncommitted
 * bump) -- that half cannot become an import, but it must point at `protocol-version.ts` (`.mjs` before layer v0.9.0) now, or it
 * would silently stop matching anything the moment this move landed as a real commit: the constant no
 * longer exists in `capture-core.mjs`'s text at all.
 */
test("the git-HEAD comparison targets protocol-version.ts, not the file the constant moved OUT of", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  for (const file of ["packages/worker-fleet/src/check-worker-code.ts"]) {
    const source = readFileSync(resolve(root, file), "utf8");
    // `git -C <the worker's source dir> show HEAD:./protocol-version.ts` (#3394): the directory is asked of the
    // worker package rather than named here, so `./` is the version file's own directory. `.mjs` is what layer tags
    // before v0.9.0 ship, and the control guard reads both (#4708), so this one accepts both.
    if (readsProtocolVersion(source)) assert.match(source, /"-C",[^\]]*"show",\s*"HEAD:\.\/protocol-version\.(?:ts|mjs)"/,
      `${file}'s HEAD comparison must target protocol-version.ts (or the older .mjs) -- capture-core.mjs no longer declares `
      + "the constant, so scraping it there would silently stop matching");
    assert.doesNotMatch(source, /HEAD:(?:\.\/|packages\/nvda-worker\/src\/)capture-core\.mjs/,
      `${file} still compares against capture-core.mjs at HEAD, which the constant no longer lives in`);
  }
});
