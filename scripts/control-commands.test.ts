/**
 * CONTROL STARTS ITS OWN COMMANDS (ADR 0045 cut 7, a11ign/a11ign#5085).
 *
 * The core started 31 of control's commands from its own `package.json` (`fleet:*`, `lab:*`, `doctor`, `worker:code`), by a path into a laid
 * copy of this package. They are this repository's now, under the names the core used, and this file is where "they exist, and each one
 * names a file this repository holds" is held: it runs in this repository's own `pnpm test`, which `src/` tests do not (they run laid in the
 * core, whose manifest for this package carries no `scripts`).
 *
 * WHAT IT DOES NOT SHOW: a command RUNNING. Running `fleet:*` and `lab:*` reaches the fleet and the lab, which the row that wrote this may
 * not do (the resource ban). The row that deploys with the pins runs `fleet:deploy --limit=<one box>` and is the reading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string>; dependencies?: Record<string, string>; };
/** The two published layers, package name -> pinned version, as `deploy-pins.json` holds them. */
const PINNED_LAYERS = Object.fromEntries(
  Object.values((JSON.parse(readFileSync(new URL("../deploy-pins.json", import.meta.url), "utf8")) as { layers: Record<string, { package: string, version: string }> }).layers)
    .map((layer) => [layer.package, layer.version]),
);

/**
 * The commands the core's `package.json` started with `packages/control` in them, at a11ign/a11ign `70361744f`: 31, less `fleet:patch-schedule`, which A11-205
 * deleted with the patch window. The freeze's own commands are `FREEZE_COMMANDS` below.
 */
const COMMANDS = [
  "doctor", "worker:code", "fleet:status", "fleet:link-view", "fleet:discover", "fleet:wake", "fleet:auto-off", "fleet:auto-off-schedule",
  "lab:job", "lab:pipeline", "lab:failed-units", "lab:watch", "fleet:watch", "lab:status", "lab:log", "fleet:tailscale",
  "fleet:deploy", "fleet:sleep", "fleet:provision", "fleet:patch", "lab:fetch", "lab:stop", "lab:clear-failed", "lab:reset", "lab:corpus-schedule",
  "fleet:recover", "fleet:logs", "fleet:os-rollback", "fleet:inventory-install", "fleet:control-host-install",
];

/** The file a command runs, or why none can be found in it. */
const targetOf = (command: string): string | undefined => /(?:node |ansible-playbook )(\S+\.(?:ts|yml))/.exec(command)?.[1];

/** A11-205: the freeze's commands. The daily run and the one-box proof go through the wrapper; the timer is installed by its own playbook. */
const FREEZE_COMMANDS = ["fleet:freeze", "fleet:freeze-proof", "fleet:freeze-schedule", "fleet:drift"];

test("the 30 commands are control's, none reaches into `packages/control`, and each names a file this repository holds", () => {
  assert.equal(COMMANDS.length, 30, "positive control: the list is the 31 the row names, less the patch window's timer");
  const problems: string[] = [];
  for (const name of [...COMMANDS, ...FREEZE_COMMANDS]) {
    const command = manifest.scripts[name];
    if (command === undefined) { problems.push(`${name}: not in package.json`); continue; }
    if (command.includes("packages/control")) problems.push(`${name}: ${command} still reaches into a laid packages/control`);
    const target = targetOf(command);
    if (target === undefined || !existsSync(`${ROOT}${target}`)) problems.push(`${name}: ${command} names ${target ?? "no file"}, which is not here`);
  }
  assert.deepEqual(problems, []);
});

test("a command that runs ansible takes its config from this repository's own ansible/", () => {
  const ansible = [...COMMANDS, ...FREEZE_COMMANDS].filter((name) => manifest.scripts[name]?.includes("ansible-playbook"));
  assert.ok(ansible.length >= 10, `positive control: ${ansible.length} commands run ansible`);
  for (const name of ansible) assert.match(manifest.scripts[name], /^ANSIBLE_CONFIG=ansible\/ansible\.cfg ansible-playbook ansible\//, name);
});

test("the lab commands a lab job dispatch and watch use are all here: job, pipeline, status, log, stop, fetch, reset, watch, failed-units", () => {
  for (const name of ["lab:job", "lab:pipeline", "lab:status", "lab:log", "lab:stop", "lab:fetch", "lab:reset", "lab:watch", "lab:failed-units"]) {
    assert.ok(manifest.scripts[name], `${name} is not a command of this package`);
  }
});

test("`doctor` and `worker:code` run the fleet's bins by name, from the pinned release, and declare no dependency beyond the two pinned layers", () => {
  assert.equal(manifest.scripts.doctor, "node src/with-control-plane-fleet.ts doctor");
  assert.equal(manifest.scripts["worker:code"], "node src/with-control-plane-fleet.ts worker-code");
  assert.deepEqual(manifest.dependencies ?? {}, PINNED_LAYERS, "the only declared dependencies are the two published layers at their pins (ADR 0045); anything else is installed beside the fleet key (ADR 0012)");
});

test("A11-205: the patch window's timer command is gone, no schedule command installs a patch timer, and the deliberate upgrade is still a command", () => {
  assert.equal(manifest.scripts["fleet:patch-schedule"], undefined, "the command that installed the window's timer is deleted");
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (/schedule/.test(name)) assert.doesNotMatch(command, /patch/, `${name} must not install a patch timer`);
  }
  assert.equal(manifest.scripts["fleet:patch"], "node src/fleet-upgrade.ts", "negative control: fleet:patch remains, and it is the chain (deploy.yml, patch.yml, the closing read), not one play");
  assert.equal(manifest.scripts["fleet:drift"], "node src/fleet-drift.ts", "the hourly read is a command a person can run too");
  assert.match(manifest.scripts["fleet:freeze-schedule"], /freeze-schedule\.yml$/);
});
