/**
 * THE FLEET JOB SERVICE REACHES THE CONTROL PLANE ONLY THE WAY THIS REPOSITORY ALLOWS (A11-243): through Ansible, under a unit that names its loader and its
 * own checkout, from modules that import nothing the plane does not hold, and starting no play. Source text, with an anti-vacuity guard on each reading: the
 * unit cannot be started without a control plane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { deriveShippedUnits } from "../control-unit-drift.ts";
import { LEDGER_DIR } from "../fleet-leases/paths.ts";
import { CONTROL_TSX_LOADER, SERVICE_CHECKOUT, SERVICE_UNIT, STORE_DIR } from "./paths.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const UNIT = read(`ansible/files/${SERVICE_UNIT}`);
const PLAYBOOK = read("ansible/fleet-jobs-install.yml");
/** The playbook without its comment lines, which explain what the tasks avoid. */
const TASKS = PLAYBOOK.replace(/^\s*#.*$/gm, "");
const keys = (unit: string, key: string): string[] => [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!.trim());

test("the unit runs the service through the loader the plane holds, from the service's own checkout, with the state directory the store is", () => {
  assert.deepEqual(keys(UNIT, "ExecStart"), [`/usr/bin/node --import ${CONTROL_TSX_LOADER} ${SERVICE_CHECKOUT}/src/fleet-jobs/service.ts`]);
  assert.deepEqual(keys(UNIT, "WorkingDirectory"), [SERVICE_CHECKOUT]);
  assert.deepEqual(keys(UNIT, "StateDirectory"), [[STORE_DIR, LEDGER_DIR].map((dir) => dir.replace("/var/lib/", "")).join(" ")], "the job store, and the lease ledger beside it");
  assert.deepEqual(keys(UNIT, "Restart"), ["on-failure"]);
  assert.deepEqual(keys(UNIT, "Type"), ["simple"]);
});

test("the unit's loader is the one control-host-install.yml asserts, and the playbook runs it before it installs the unit", () => {
  const asserted = /^\s*control_tsx_loader:\s*(\S+)\s*$/m.exec(read("ansible/control-host-install.yml"))?.[1];
  assert.equal(asserted, CONTROL_TSX_LOADER);
  assert.equal(/^\s*control_tsx_loader:\s*(\S+)\s*$/m.exec(PLAYBOOK)?.[1], CONTROL_TSX_LOADER);
  assert.ok(PLAYBOOK.indexOf("The loader the service runs under must resolve") < PLAYBOOK.indexOf("Install the unit file"), "a plane without the loader fails before the unit is installed");
});

test("the stop waits longer than the worker's own capture limit, so systemd does not kill a capture it is waiting for", () => {
  const stop = Number(keys(UNIT, "TimeoutStopSec")[0]);
  assert.ok(stop > 600, `TimeoutStopSec=${stop} must exceed the worker's 600 s capture limit`);
  assert.deepEqual(keys(UNIT, "KillSignal"), ["SIGTERM"]);
});

test("the playbook is shaped as control-unit-drift reads it: it ships the unit by name, to the control plane, and nothing else", () => {
  const derived = deriveShippedUnits({ playbooks: () => [PLAYBOOK] });
  assert.deepEqual(derived, { units: [SERVICE_UNIT] });
});

test("the playbook has the service's own checkout at the ref asked for, defaulting to main, and the paths the unit names", () => {
  assert.match(PLAYBOOK, /^\s*fleet_jobs_ref: main\s*$/m);
  assert.match(PLAYBOOK, new RegExp(`^\\s*fleet_jobs_checkout: ${SERVICE_CHECKOUT}\\s*$`, "m"));
  assert.match(PLAYBOOK, new RegExp(`^\\s*fleet_jobs_store: ${STORE_DIR}\\s*$`, "m"));
  assert.match(PLAYBOOK, /version: "\{\{ fleet_jobs_ref \}\}"/);
  assert.ok(!/\/root\/control\b/.test(TASKS), "it never touches the checkout the auto-off timer keeps on main");
});

test("the playbook reads the service back: SubState running, then a heartbeat that names the checkout's commit and is fresh", () => {
  assert.match(PLAYBOOK, /--property=SubState, --value/);
  assert.match(PLAYBOOK, /until: fleet_jobs_substate\.stdout \| trim == 'running'/);
  assert.match(PLAYBOOK, /\(fleet_jobs_beat_text\.stdout \| from_json\)\.commit == \(fleet_jobs_head\.stdout \| trim\)/);
  assert.match(PLAYBOOK, /heartbeat must be fresh/);
  assert.match(PLAYBOOK, /state: "\{\{ 'restarted' if \(fleet_jobs_checkout_state\.changed/, "restarted only when what it runs moved");
});

test("the playbook installs the lockfile alone, with no install script, as ADR 0012 and 0045 allow", () => {
  assert.match(PLAYBOOK, /--frozen-lockfile, --ignore-scripts, --prod/);
  const argvs = [...TASKS.matchAll(/^\s*argv: (.*)$/gm)].map((m) => m[1]!);
  assert.ok(argvs.length >= 8, `the scan found the playbook's commands: ${argvs.length}`);
  assert.deepEqual(argvs.filter((argv) => /\bnpm\b|\bnpx\b|pnpm, (add|dlx|update)/.test(argv)), [], "nothing installs but the lockfile");
});

test("the service's modules start no play and name no playbook, so the job service cannot change a box", () => {
  const service = readdirSync(new URL("src/fleet-jobs/", ROOT)).filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".fixture.") && f !== "fake-fleet.ts" && f !== "cli.ts");
  assert.ok(service.includes("runner.ts") && service.includes("service.ts") && service.includes("boxes.ts"), `the readdir found the service's modules: ${service}`);
  for (const file of service) {
    const source = read(`src/fleet-jobs/${file}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(source, /ansible-playbook|systemd-run|fleet-playbook|\.yml\b|provision|\/admin\//, `${file} reaches for a play`);
  }
});

test("every module of the job service imports only node:, the two published layers and its own relative files (ADR 0012, 0045)", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const layers = JSON.parse(read("deploy-pins.json")).layers as Record<string, { package: string }>;
  const allowed = Object.values(layers).map((layer) => layer.package);
  const seen = new Set<string>();
  const offenders: string[] = [];
  const reached = new Set<string>();
  const walk = (url: URL): void => {
    if (seen.has(url.pathname)) return;
    seen.add(url.pathname);
    for (const [, spec] of strip(readFileSync(url, "utf8")).matchAll(/\bfrom\s+"([^"]+)"/g)) {
      if (spec!.startsWith("node:")) continue;
      if (allowed.some((name) => spec === name || spec!.startsWith(`${name}/`))) { reached.add(spec!); continue; }
      if (spec!.startsWith(".")) { walk(new URL(spec!, url)); continue; }
      offenders.push(`${url.pathname.split("/").slice(-2).join("/")} imports "${spec}"`);
    }
  };
  for (const entry of ["service.ts", "remote.ts", "cli.ts"]) walk(new URL(`src/fleet-jobs/${entry}`, ROOT));
  assert.deepEqual(offenders, []);
  assert.ok(reached.has("@a11ign/screenreader-fleet/capture-client"), "positive control: the walk reaches the capture client the service uses");
  assert.ok(seen.size > 10, `the walk followed ${seen.size} files`);
});
