/**
 * A GUEST HOLDS EACH LAYER'S CHECKOUT AT ITS OWN PINNED COMMIT, BESIDE THE CORE'S (ADR 0039 item 6, row 6b, #3395).
 *
 * Every guest play was written for ONE repository: fetch, checkout, fast-forward and assert a single
 * `a11y_expected_commit`, and rewrite the one `origin`. A layer in a second repository means a second of each,
 * and the failure if one is missed is silent -- the core lands on its pin, the layer stays wherever its branch
 * was, and the worker serves a version nobody chose. A play is only text to a CI job, so this reads the plays as
 * text: it pins that every play which moves the core also carries the layer's block, that the block runs in the
 * LAYER's directory and never the core's, that the expected commit is a pair whose halves are asserted
 * separately, and that the two plays rewriting `origin` take the layer's by name.
 *
 * What it cannot show is a guest doing it: that is the fleet step on the row, one worker first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { layerCommitsExtraVars, layerPinsFor, layerRefValues, layersFrom, separateLayers } from "./layer-checkouts.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ANSIBLE = resolve(REPO, "packages/control/ansible");
const read = (rel: string) => readFileSync(resolve(ANSIBLE, rel), "utf8");

/** Comments out: a verb named in PROSE is not a verb that runs. */
const codeText = (source: string) => source.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

function ymlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : ymlFiles(path);
    return entry.name.endsWith(".yml") ? [relative(ANSIBLE, path)] : [];
  });
}

/** The task files that ARE the layer's block. Everything else is a play that moves the core. */
const LAYER_FILES = ["tasks/layer-checkouts.yml", "tasks/layer-origins.yml", "tasks/read-layer-checkouts.yml",
  "tasks/require-layer-origin-names.yml"];

/** A git verb that MOVES a guest's core checkout or its `origin`: a read (`rev-parse`) leaves nothing to pin. */
const MOVES_THE_CORE = /merge --ff-only|remote set-url|clone /;
const NAMES_THE_CORE_PATH = /a11y_repo_path|worker_repo_path/;

/** Derived from the tree, not listed, so a play added later that moves the core is a failure here until it declares a block. */
const playsMovingTheCore = ymlFiles(ANSIBLE)
  .filter((file) => !LAYER_FILES.includes(file))
  .filter((file) => {
    const code = codeText(read(file));
    return MOVES_THE_CORE.test(code) && NAMES_THE_CORE_PATH.test(code);
  })
  .sort();

/** What each kind of play must carry. A play pins ONE kind: the merge plays pin the commit, the origin plays the remote. */
const BLOCKS: Record<string, string[]> = {
  "deploy.yml": ["tasks/layer-checkouts.yml"],
  "provision.yml": ["tasks/layer-checkouts.yml"],
  "provision-role.yml": ["tasks/layer-checkouts.yml"],
  "reset-checkout.yml": ["tasks/layer-origins.yml", "tasks/require-layer-origin-names.yml"],
  "update-origin-remote.yml": ["tasks/layer-origins.yml", "tasks/require-layer-origin-names.yml"],
};

/** The refusal a play without its layer block gets, as a value: the positive control calls it on a mutated copy. */
function layerBlockMissing(file: string, source: string): string | null {
  if (file === "roles/worker/tasks/packages.yml") {
    const code = codeText(source);
    return /loop:\s*"\{\{ worker_layer_checkouts \}\}"/.test(code) && code.includes("item.value.remote") ? null
      : `${file} clones the core and has no clone of each layer with its own repository`;
  }
  const code = codeText(source);
  const missing = (BLOCKS[file] ?? []).filter((task) => !code.includes(`include_tasks: ${task}`));
  if (!BLOCKS[file]) return `${file} moves the core on a guest and declares no layer block (add it to BLOCKS)`;
  return missing.length ? `${file} lacks ${missing.join(", ")}` : null;
}

test("the plays that move a guest's core checkout are the ones this file knows (the control of every loop below)", () => {
  assert.deepEqual(playsMovingTheCore, [
    "deploy.yml", "provision-role.yml", "provision.yml", "reset-checkout.yml", "roles/worker/tasks/packages.yml",
    "update-origin-remote.yml"]);
});

test("every play that moves the core has a block for each layer, and one without it is refused", () => {
  for (const file of playsMovingTheCore) assert.equal(layerBlockMissing(file, read(file)), null, file);

  // Positive control, for the emptiness above: the SAME check on a copy with the block deleted must refuse.
  const mutated = (file: string, pattern: RegExp) => read(file).replace(pattern, "");
  assert.match(layerBlockMissing("deploy.yml", mutated("deploy.yml", /include_tasks: tasks\/layer-checkouts\.yml/))!,
    /lacks tasks\/layer-checkouts\.yml/);
  assert.match(layerBlockMissing("update-origin-remote.yml",
    mutated("update-origin-remote.yml", /include_tasks: tasks\/layer-origins\.yml/))!, /lacks tasks\/layer-origins\.yml/);
  assert.match(layerBlockMissing("roles/worker/tasks/packages.yml",
    mutated("roles/worker/tasks/packages.yml", /worker_layer_checkouts/g))!, /no clone of each layer/);
  assert.match(layerBlockMissing("brand-new-play.yml", "- ansible.windows.win_shell: git merge --ff-only x")!,
    /declares no layer block/);
});

test("every layer git call runs in the LAYER's directory, never the core checkout's", () => {
  for (const file of LAYER_FILES.filter((name) => name !== "tasks/read-layer-checkouts.yml")) {
    const code = codeText(read(file));
    const chdirs = code.split("\n").filter((line) => /^\s*chdir:/.test(line));
    for (const line of chdirs) {
      assert.match(line, /item\.value\.path/, `${file}: ${line.trim()} would run a layer's git in the core checkout`);
    }
    // The tasks that run git without a chdir say where in the script itself, by the layer's own path.
    for (const task of code.split(/\n- name:/).filter((chunk) => /win_shell/.test(chunk) && !/chdir:/.test(chunk))) {
      assert.match(task, /\$layer = '\{\{ (a11y|worker)_repo_path \}\}\/\{\{ item\.value\.path \}\}'/, file);
    }
  }
  const packages = codeText(read("roles/worker/tasks/packages.yml"));
  assert.match(packages, /\$layer = '\{\{ worker_repo_path \}\}\/\{\{ item\.value\.path \}\}'/);
});

test("the expected commit is a pair, and each half is asserted on its own", () => {
  const deploy = codeText(read("deploy.yml"));
  assert.match(deploy, /guest_head\.stdout_lines \| last \| trim == a11y_expected_commit/, "the core half");

  const layers = codeText(read("tasks/layer-checkouts.yml"));
  assert.match(layers, /item\.stdout_lines \| last \| trim == a11y_layer_commits\[item\.item\.key\]/, "the layer half");
  assert.match(layers, /merge --ff-only --quiet \{\{ a11y_layer_commits\[item\.key\] \}\}/, "merged to ITS pin");
  // No default: a guessed layer commit is a wrong answer about a repository nobody named. The core's own
  // `default('origin/...')` belongs to the core's line alone.
  assert.doesNotMatch(layers, /a11y_expected_commit|a11y_git_ref|origin\//, "the core's pin must not stand in for the layer's");
  assert.match(layers, /a11y_layer_commits \| default\(\{\}\)\)\[item\.key\] is match\('\^\[0-9a-f\]\{40\}\$'\)/,
    "an unpinned or abbreviated layer is refused before any box is touched");
});

test("the plays that rewrite origin take the layer's remote by name and never rewrite the core's by accident", () => {
  const origins = codeText(read("tasks/layer-origins.yml"));
  assert.match(origins, /remote set-url origin '\{\{ new_layer_repo_urls\[item\.key\] \}\}'/);
  assert.doesNotMatch(origins, /new_repo_url/, "the core's address must not reach a layer");

  const names = codeText(read("tasks/require-layer-origin-names.yml"));
  assert.match(names, /item\.key in \(a11y_layer_checkouts \| map\(attribute='key'\) \| list\)/, "a typo is refused");

  // And the converse: the core's own set-url still takes new_repo_url, in the CORE's directory.
  for (const file of ["reset-checkout.yml", "update-origin-remote.yml"]) {
    assert.match(codeText(read(file)), /remote set-url origin '\{\{ new_repo_url \}\}'/, file);
  }
});

test("no play names a layer: the list is read from layers.json, so a second copy cannot go stale", () => {
  // The layer files, and the one task in the role that clones a layer. The plays themselves may name the worker
  // for other reasons (`deploy.yml` reads its code version through the resolver), so they are not scanned whole.
  for (const file of LAYER_FILES) assert.doesNotMatch(codeText(read(file)), /nvda-worker|nvda_worker/, file);
  const layerTask = codeText(read("roles/worker/tasks/packages.yml")).split("\n- name:").find((task) => /worker_layer_checkouts/.test(task));
  assert.doesNotMatch(layerTask ?? "", /nvda-worker|nvda_worker/);
  for (const file of LAYER_FILES.filter((name) => name === "tasks/read-layer-checkouts.yml")) {
    assert.match(read(file), /lookup\('file', playbook_dir ~ '\/\.\.\/layers\.json'\)/);
  }
  assert.match(read("roles/worker/defaults/main.yml"), /lookup\('file', playbook_dir ~ '\/\.\.\/layers\.json'\)/);
});

test("the bootstrap script reads the same manifest from its fresh clone", () => {
  const ps1 = readFileSync(resolve(REPO, "packages/worker-fleet/src/provisioning/bootstrap-windows-worker.ps1"), "utf8");
  const code = ps1.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const block = code.slice(code.indexOf("$layersManifest ="), code.indexOf("no separate layer to clone"));
  assert.match(block, /packages\\control\\layers\.json/);
  assert.match(block, /if \(-not \$layer\.Value\.remote\) \{ continue \}/, "an in-repo layer needs no second clone");
  assert.match(block, /'clone', \$layer\.Value\.remote, \$layerPath/);
  assert.doesNotMatch(block, /nvda-worker/, "the list is the manifest's, not this script's");
});

// ---- the operator's half: --layer-ref ---------------------------------------------------------------------------

const FULL_SHA_LENGTH = 40;
const SHA_A = "a".repeat(FULL_SHA_LENGTH);
const SHA_B = "b".repeat(FULL_SHA_LENGTH);
const manifest = {
  layers: {
    inside: { path: "packages/inside" },
    "worker-layer": { path: "packages/worker-layer", remote: "https://github.com/a11ign/screenreader-worker.git" },
    "speech-layer": { path: "packages/speech-layer", remote: "https://github.com/a11ign/speech.git", branch: "main" },
  },
};
const fixture = layersFrom({ manifest, root: "/nowhere" });

test("only a layer that declares a remote is a second checkout", () => {
  assert.deepEqual(fixture.separateLayers(), ["worker-layer", "speech-layer"]);
});

test("--layer-ref pins every separate layer by a full sha, and refuses everything else by name", () => {
  const ok = fixture.layerPins([`worker-layer=${SHA_A}`, `speech-layer=${SHA_B}`]);
  assert.deepEqual(ok, { pins: { "worker-layer": SHA_A, "speech-layer": SHA_B }, refusal: null });

  const refusals = {
    "no pins at all": fixture.layerPins([]),
    "one layer left unpinned": fixture.layerPins([`worker-layer=${SHA_A}`]),
    "an abbreviated sha": fixture.layerPins(["worker-layer=abc1234", `speech-layer=${SHA_B}`]),
    "an upper-case sha": fixture.layerPins([`worker-layer=${SHA_A.toUpperCase()}`, `speech-layer=${SHA_B}`]),
    "a layer inside the core": fixture.layerPins([`inside=${SHA_A}`, `worker-layer=${SHA_A}`, `speech-layer=${SHA_B}`]),
    "an undeclared layer": fixture.layerPins([`ghost=${SHA_A}`, `worker-layer=${SHA_A}`, `speech-layer=${SHA_B}`]),
    "the same layer twice": fixture.layerPins([`worker-layer=${SHA_A}`, `worker-layer=${SHA_B}`, `speech-layer=${SHA_B}`]),
    "a shell metacharacter": fixture.layerPins([`worker-layer=${SHA_A}'; id`, `speech-layer=${SHA_B}`]),
  };
  for (const [what, result] of Object.entries(refusals)) {
    assert.match(result.refusal ?? "", /^refusing /, what);
    assert.deepEqual(result.pins, {}, `${what}: a refusal carries no pins`);
  }
});

test("the manifest's own state today: no layer has a remote, so the pair is a single sha and nothing is forwarded", () => {
  assert.deepEqual(separateLayers(), []);
  assert.deepEqual(layerPinsFor({ chosen: "deploy.yml", given: [] }), { pins: {}, refusal: null });
  assert.equal(layerCommitsExtraVars({}), "");
  // A pin for a layer that has no repository of its own is refused rather than dropped.
  assert.match(layerPinsFor({ chosen: "deploy.yml", given: [`nvda-worker=${SHA_A}`] }).refusal ?? "", /not a layer with its own repository/);
});

test("--layer-ref is refused on a playbook that pins no layer, and forwarded as JSON the remote shell cannot unquote", () => {
  assert.match(layerPinsFor({ chosen: "sleep.yml", given: [`worker-layer=${SHA_A}`] }).refusal ?? "",
    /only deploy\.yml and provision-role\.yml pin a layer/);
  assert.equal(layerPinsFor({ chosen: "sleep.yml", given: [] }).refusal, null);
  assert.equal(layerCommitsExtraVars({ "worker-layer": SHA_A }), ` -e '{"a11y_layer_commits":{"worker-layer":"${SHA_A}"}}'`);
  assert.deepEqual(layerRefValues(["--ref=main", `--layer-ref=a=${SHA_A}`, `--layer-ref=b=${SHA_B}`]), [`a=${SHA_A}`, `b=${SHA_B}`]);
});

test("fleet-playbook declares the flag, and sends the pins in the command it builds", () => {
  const source = readFileSync(resolve(REPO, "packages/control/src/fleet-playbook.mjs"), "utf8");
  assert.match(source, /"--display-mode=", "--layer-ref="\]/, "an undeclared flag is IGNORED, so it must be on the list");
  assert.match(source, /\+ layerCommitsExtraVars\(layerCommits\)/);
});
