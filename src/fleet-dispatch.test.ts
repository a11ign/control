// no-token: captureTimes -- every test drives pure functions or `cli`/`resolveDispatch` with an injected probe, ledger reader, wake and clock; the only `captureTimes` call is `loadByWorker` over a literal ledger, and nothing here reaches `fleet-watch.ts`'s `gh issue comment`.
/**
 * `fleet-dispatch.ts` and its wiring in `lab-job.yml` (a11ign#5017, part of #4405 item 4).
 *
 * THREE LEVELS, each with a control that shows it can fail: the pure chooser (`chooseWorkers`), the I/O around
 * it with every dependency a fake (`resolveDispatch`, `cli`), and the PLAYBOOK, whose real tasks are lifted
 * byte for byte and run under `ansible-playbook` against a stub resolver. A text pin on the playbook cannot say
 * that a refusal fires, so the refusals are rendered, not read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chooseWorkers, cli, loadByWorker, parsePool, parseRequest, resolveDispatch, stateOfProbe,
  type DispatchRequest, type Load, type PoolBox,
} from "./fleet-dispatch.ts";
import type { CapturesState } from "./fleet-watch.ts";
import type { Probe, WakeResult, WakeTarget } from "./fleet-wake.ts";

const CATALOGUE = readFileSync(new URL("../ansible/lab-job.yml", import.meta.url), "utf8");
const EXAMPLE = readFileSync(new URL("../ansible/inventory.example.yml", import.meta.url), "utf8");

// ---------------------------------------------------------------------------------------------------------
// The chooser. A fixture in which the least-loaded boxes are NOT the first ones by name, so a sort by name
// is a different answer and the assertion below can tell them apart.
// ---------------------------------------------------------------------------------------------------------

const POOL: PoolBox[] = [
  { name: "a11y-worker-2", state: "ready" },
  { name: "a11y-worker-3", state: "unreachable" },
  { name: "a11y-worker-4", state: "ready" },
  { name: "a11y-worker-5", state: "warming" },
  { name: "a11y-worker-6", state: "busy" },
  { name: "a11y-worker-7", state: "ready" },
  { name: "a11y-worker-10", state: "ready" },
];
const LOAD: Load = {
  "a11y-worker-2": 90, "a11y-worker-3": 0, "a11y-worker-4": 40, "a11y-worker-5": 0,
  "a11y-worker-6": 0, "a11y-worker-7": 7, "a11y-worker-10": 7,
};

const chosenFor = (request: DispatchRequest, pool: PoolBox[] = POOL, load: Load = LOAD) => {
  const choice = chooseWorkers({ request, pool, load });
  assert.equal(choice.refusal, null);
  return choice;
};

test("`ready` returns every ready box, and not an off, warming or busy one", () => {
  const { chosen } = chosenFor("ready");
  assert.deepEqual([...(chosen ?? [])].sort(), ["a11y-worker-10", "a11y-worker-2", "a11y-worker-4", "a11y-worker-7"]);
  for (const state of ["unreachable", "warming", "busy"]) {
    const box = POOL.find((candidate) => candidate.state === state) as PoolBox;
    assert.ok(!chosen?.includes(box.name), `${box.name} is ${state} and was chosen`);
    assert.ok(LOAD[box.name] === 0, "the excluded boxes are the LEAST loaded, so only the state keeps them out");
  }
});

test("N returns the N least loaded, ties by name with worker-7 before worker-10", () => {
  assert.deepEqual(chosenFor(2).chosen, ["a11y-worker-7", "a11y-worker-10"]);
  assert.deepEqual(chosenFor(3).chosen, ["a11y-worker-7", "a11y-worker-10", "a11y-worker-4"]);
});

test("MUTATION: a chooser that sorts by name instead answers differently on this fixture, so the pin above bites", () => {
  const byName = POOL.filter((box) => box.state === "ready").map((box) => box.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true })).slice(0, 2);
  assert.deepEqual(byName, ["a11y-worker-2", "a11y-worker-4"]);
  assert.notDeepEqual(byName, chosenFor(2).chosen);
});

test("fewer ready boxes than N returns the ones that exist, says so, and does not pad with a box that is not ready", () => {
  const choice = chosenFor(6);
  assert.equal(choice.chosen?.length, 4);
  assert.equal(choice.short, true);
  assert.match(choice.notes.join(" "), /6 were asked for and 4 boxes are ready/);
  assert.match(choice.notes.join(" "), /a11y-worker-3 \(unreachable\).*a11y-worker-5 \(warming\).*a11y-worker-6 \(busy\)/);
  assert.equal(chosenFor(4).short, false, "exactly enough is not short (the control for `short` above)");
});

test("no ready box at all returns nothing and says why", () => {
  const choice = chosenFor("ready", POOL.filter((box) => box.state !== "ready"));
  assert.deepEqual(choice.chosen, []);
  assert.match(choice.notes.join(" "), /No box is ready/);
});

test("a box with no capture count ranks after every box with one, and is named: unknown is not zero", () => {
  const partial: Load = { "a11y-worker-2": 90, "a11y-worker-4": 40 };
  const three = chosenFor(3, POOL, partial);
  assert.deepEqual(three.chosen, ["a11y-worker-4", "a11y-worker-2", "a11y-worker-7"],
    "the two boxes WITH a reading come first, then the first unread by name");
  assert.match(three.notes.join(" "), /No capture count for a11y-worker-7:/, "named when a chosen box has none");
  assert.deepEqual(chosenFor(2, POOL, partial).notes, [], "and silent when every chosen box has a count (the control)");
  assert.deepEqual(chosenFor("ready", POOL, {}).chosen,
    ["a11y-worker-2", "a11y-worker-4", "a11y-worker-7", "a11y-worker-10"], "no ledger at all: by name");
});

test("a request that is not `ready` or a whole number is refused rather than read as something", () => {
  for (const request of [0, -1, 2.5, Number.NaN] as DispatchRequest[]) {
    const choice = chooseWorkers({ request, pool: POOL, load: LOAD });
    assert.equal(choice.chosen, null, `${request}`);
    assert.match(choice.refusal ?? "", /not a request/);
  }
  assert.equal(parseRequest("ready"), "ready");
  assert.equal(parseRequest("12"), 12);
  for (const text of ["0", "-1", "2.5", "all", "", "Ready", "1,2", "0x3"]) assert.equal(parseRequest(text), null, text);
});

test("the load is each worker's own rises inside 24 h, and an unreadable ledger is no load, not zero load", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const hour = 3_600_000;
  const state: CapturesState = {
    since: now - 30 * hour,
    workers: {
      "a11y-worker-2": { captures: 50, seenAt: now, lastRoseAt: now - hour,
        rises: [{ at: now - hour, by: 5 }, { at: now - 23 * hour, by: 3 }, { at: now - 25 * hour, by: 100 }] },
      "a11y-worker-3": { captures: 0, seenAt: now, lastRoseAt: null, rises: [] },
    },
  };
  assert.deepEqual(loadByWorker(state, now), { "a11y-worker-2": 8, "a11y-worker-3": 0 });
  assert.deepEqual(loadByWorker(null, now), {});
});

// ---------------------------------------------------------------------------------------------------------
// The I/O around it, every dependency a fake: no socket, no packet, no ssh.
// ---------------------------------------------------------------------------------------------------------

const TARGETS: WakeTarget[] = POOL.map((box, i) => ({ name: box.name, host: `192.0.2.${10 + i}`, mac: null }));
const PROBES: Record<string, Probe> = {
  ready: { outcome: "ready" }, busy: { outcome: "busy" },
  warming: { outcome: "not-ready", reason: "ShellExperienceHost holds the foreground" },
  unreachable: { outcome: "no-answer", message: "ETIMEDOUT" },
};

function fakes(wakeState: (name: string) => string = () => "already-up") {
  const woken: string[][] = [];
  return {
    woken,
    deps: {
      probe: async (url: string): Promise<Probe> => {
        const target = TARGETS.find((candidate) => url.includes(`${candidate.host}:`)) as WakeTarget;
        return PROBES[(POOL.find((box) => box.name === target.name) as PoolBox).state] as Probe;
      },
      readLoad: () => LOAD,
      wake: async (workers: WakeTarget[]): Promise<WakeResult[]> => {
        woken.push(workers.map((w) => w.name));
        return workers.map((w) => ({ ...w, state: wakeState(w.name), packets: 0 }));
      },
      now: () => 0,
    },
  };
}

test("a probe becomes the `fleet:status` word: refused is up and not listening, which is warming", () => {
  assert.equal(stateOfProbe({ outcome: "ready" }), "ready");
  assert.equal(stateOfProbe({ outcome: "busy" }), "busy");
  assert.equal(stateOfProbe({ outcome: "not-ready", reason: "x" }), "warming");
  assert.equal(stateOfProbe({ outcome: "refused", message: "ECONNREFUSED" }), "unreachable");
  assert.equal(stateOfProbe({ outcome: "no-answer", message: "ETIMEDOUT" }), "unreachable");
});

test("resolveDispatch probes the pool, chooses by load, and wakes ONLY the chosen", async () => {
  const { deps, woken } = fakes();
  const choice = await resolveDispatch({ request: 2, pool: TARGETS }, deps);
  assert.deepEqual(choice.chosen, ["a11y-worker-7", "a11y-worker-10"]);
  assert.deepEqual(woken, [["a11y-worker-7", "a11y-worker-10"]], "the other eleven boxes are sent nothing");
});

test("a chosen box that does not come up when woken is left out and named, not padded", async () => {
  const { deps } = fakes((name) => (name === "a11y-worker-7" ? "no-answer" : "already-up"));
  const choice = await resolveDispatch({ request: 2, pool: TARGETS }, deps);
  assert.deepEqual(choice.chosen, ["a11y-worker-10"]);
  assert.equal(choice.short, true);
  assert.match(choice.notes.join(" "), /did not come up when woken.*a11y-worker-7/);
});

test("nothing is woken when nothing is chosen", async () => {
  const { deps, woken } = fakes();
  const none = TARGETS.filter((target) => PROBES[(POOL.find((box) => box.name === target.name) as PoolBox).state]?.outcome !== "ready");
  const choice = await resolveDispatch({ request: "ready", pool: none }, { ...deps,
    probe: async () => ({ outcome: "no-answer", message: "ETIMEDOUT" }) });
  assert.deepEqual(choice.chosen, []);
  assert.deepEqual(woken, []);
});

const POOL_JSON = JSON.stringify(TARGETS.map(({ name, host }) => ({ name, host, mac: "00:00:00:00:00:12" })));

test("the CLI prints one JSON object on stdout and exits 0", async () => {
  const result = await cli(["--request=2", `--pool=${POOL_JSON}`], fakes().deps);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { request: 2, chosen: ["a11y-worker-7", "a11y-worker-10"], short: false, notes: [] });
});

test("the CLI exits 3 and prints nothing on stdout when nothing is ready, so an empty list cannot be taken", async () => {
  const deps = { ...fakes().deps, probe: async (): Promise<Probe> => ({ outcome: "no-answer", message: "ETIMEDOUT" }) };
  const result = await cli(["--request=ready", `--pool=${POOL_JSON}`], deps);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /REFUSING: No box is ready/);
});

test("the CLI refuses a request or a pool it cannot read, and a pool entry that is not a name and an address", async () => {
  for (const argv of [["--request=0", `--pool=${POOL_JSON}`], ["--request=ready"], ["--request=ready", "--pool=not json"],
    ["--request=ready", `--pool=${JSON.stringify([{ name: "a;rm -rf", host: "192.0.2.1" }])}`],
    ["--request=ready", `--pool=${JSON.stringify([{ name: "w", host: "http://evil:8765" }])}`]]) {
    const result = await cli(argv, fakes().deps);
    assert.equal(result.code, 2, argv.join(" "));
    assert.equal(result.stdout, "");
  }
  assert.equal(typeof parsePool(POOL_JSON), "object", "a well-formed pool parses (the control for the refusals above)");
});

// ---------------------------------------------------------------------------------------------------------
// The playbook. The tasks are LIFTED from lab-job.yml and run under ansible-playbook with a stub in place of
// `src/fleet-dispatch.ts`, found where the playbook looks for it (`{{ playbook_dir }}/../src/`).
// ---------------------------------------------------------------------------------------------------------

const HAS_ANSIBLE = spawnSync("ansible-playbook", ["--version"]).status === 0;
const NO_ANSIBLE = "ansible-playbook is not on PATH -- an honest skip, not a pass. The text pins above still ran.";

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `the playbook no longer contains: ${start.trim()}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `the playbook no longer contains, after it: ${end.trim()}`);
  return text.slice(from + start.length, to);
}

const CAPTURE_MARK = "    - name: Only a literal true or false may be declared as a11y_capture";
const SELECTION_MARK = "    - name: Which workers this run may use";
const LIFTED = `${CAPTURE_MARK}\n${between(CATALOGUE, `\n${CAPTURE_MARK}\n`, "\n    # `-e workers=N` MUST NAME A POOL")}`
  + `${SELECTION_MARK}\n${between(CATALOGUE, `\n${SELECTION_MARK}\n`, "\n    - name: Address the selected workers\n")}`;

type Render = { status: number | null; output: string; selected: string[] | null; stubArgv: string[] | null };

const STUB = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "const here = new URL('.', import.meta.url);",
  "writeFileSync(new URL('argv.json', here), JSON.stringify(process.argv.slice(2)));",
  "process.stdout.write(readFileSync(new URL('stub.json', here), 'utf8'));",
].join("\n");

/** `balance` is the inventory's value, written as YAML text; `null` leaves the option undeclared. */
function render({ balance, extras = [], chosen = { chosen: [], short: false, notes: [] } }:
  { balance: string | null; extras?: string[]; chosen?: { chosen: string[]; short: boolean; notes: string[] } }): Render {
  const dir = mkdtempSync(join(tmpdir(), "lab-dispatch-balance-"));
  try {
    mkdirSync(join(dir, "ansible"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "fleet-dispatch.ts"), STUB);
    writeFileSync(join(dir, "src", "stub.json"), JSON.stringify(chosen));
    const hosts = ["a11y-worker-a", "a11y-worker-b", "a11y-worker-c", "a11y-worker-d"];
    writeFileSync(join(dir, "ansible", "inventory.yml"), [
      "all:", ...(balance === null ? [] : ["  vars:", `    lab_dispatch_balance: ${balance}`]),
      "  children:", "    a11y_workers:", "      hosts:",
      ...hosts.flatMap((name, i) => [`        ${name}:`, `          ansible_host: 192.0.2.${10 + i}`, `          mac: "00:00:00:00:00:1${i}"`]),
      "",
    ].join("\n"));
    writeFileSync(join(dir, "ansible", "play.yml"), [
      "- hosts: localhost", "  gather_facts: false", "  tasks:", LIFTED.trimEnd(),
      "    - name: Render", "      ansible.builtin.copy:",
      "        content: \"{{ {'selected': lab_selected_hosts} | to_json }}\"", `        dest: ${join(dir, "out.json")}`, "",
    ].join("\n"));
    const run = spawnSync("ansible-playbook", ["-i", "inventory.yml", "play.yml", ...extras],
      { cwd: join(dir, "ansible"), encoding: "utf8", env: { ...process.env, ANSIBLE_LOCALHOST_WARNING: "False" } });
    return { status: run.status, output: `${run.stdout}${run.stderr}`,
      selected: readJson(join(dir, "out.json"))?.selected ?? null, stubArgv: readJson(join(dir, "src", "argv.json")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(path: string) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

const skip = HAS_ANSIBLE ? undefined : NO_ANSIBLE;

test("OFF (the default): `workers=ready` is refused naming the option, and the resolver is never run", { skip }, () => {
  for (const balance of [null, "false"]) {
    const run = render({ balance, extras: ["-e", "workers=ready"] });
    assert.notEqual(run.status, 0, `balance=${balance}: ${run.output}`);
    assert.match(run.output, /lab_dispatch_balance: true/);
    assert.equal(run.stubArgv, null, "the resolver ran although the option is off");
    assert.equal(run.selected, null);
  }
});

test("OFF: `workers=<N>` is still the first N capturing hosts and a name list still works -- today's behaviour", { skip }, () => {
  const count = render({ balance: "false", extras: ["-e", "workers=2"] });
  assert.equal(count.status, 0, count.output);
  assert.deepEqual(count.selected, ["a11y-worker-a", "a11y-worker-b"]);
  const names = render({ balance: "false", extras: ["-e", "workers=a11y-worker-d,a11y-worker-b"] });
  assert.equal(names.status, 0, names.output);
  assert.deepEqual(names.selected, ["a11y-worker-d", "a11y-worker-b"]);
  assert.equal(count.stubArgv, null);
  assert.equal(names.stubArgv, null);
});

test("ON: `workers=ready` takes what the resolver chose, in inventory order, from the pool the inventory built", { skip }, () => {
  const run = render({ balance: "true", extras: ["-e", "workers=ready"],
    chosen: { chosen: ["a11y-worker-c", "a11y-worker-a"], short: false, notes: ["No capture count for a11y-worker-c."] } });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.selected, ["a11y-worker-a", "a11y-worker-c"]);
  assert.equal(run.stubArgv?.[0], "--request=ready");
  assert.deepEqual(JSON.parse((run.stubArgv?.[1] ?? "").replace(/^--pool=/, "")).map((box: { name: string; host: string; mac: string }) => [box.name, box.host, box.mac]),
    [["a11y-worker-a", "192.0.2.10", "00:00:00:00:00:10"], ["a11y-worker-b", "192.0.2.11", "00:00:00:00:00:11"],
      ["a11y-worker-c", "192.0.2.12", "00:00:00:00:00:12"], ["a11y-worker-d", "192.0.2.13", "00:00:00:00:00:13"]]);
});

test("ON: `workers=<N>` is the resolver's N, not the first N", { skip }, () => {
  const run = render({ balance: "true", extras: ["-e", "workers=2"],
    chosen: { chosen: ["a11y-worker-d", "a11y-worker-c"], short: false, notes: [] } });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.selected, ["a11y-worker-c", "a11y-worker-d"]);
  assert.equal(run.stubArgv?.[0], "--request=2");
});

test("ON: a count the resolver could only part-fill is refused, while `ready` takes what is there", { skip }, () => {
  const part = { chosen: ["a11y-worker-a"], short: true, notes: ["3 were asked for and 1 box is ready"] };
  const count = render({ balance: "true", extras: ["-e", "workers=3"], chosen: part });
  assert.notEqual(count.status, 0, count.output);
  assert.match(count.output, /given in full or refused/);
  assert.equal(count.selected, null);
  const ready = render({ balance: "true", extras: ["-e", "workers=ready"], chosen: part });
  assert.equal(ready.status, 0, ready.output);
  assert.deepEqual(ready.selected, ["a11y-worker-a"]);
});

test("ON: a name the resolver returns that is not a capturing host is refused, never addressed", { skip }, () => {
  const run = render({ balance: "true", extras: ["-e", "workers=ready"],
    chosen: { chosen: ["a11y-worker-a", "not-in-the-inventory"], short: false, notes: [] } });
  assert.notEqual(run.status, 0, run.output);
  assert.equal(run.selected, null);
});

test("ON: a name list and the no-selection default never reach the resolver", { skip }, () => {
  const names = render({ balance: "true", extras: ["-e", "workers=a11y-worker-b,a11y-worker-c"] });
  assert.equal(names.status, 0, names.output);
  assert.deepEqual(names.selected, ["a11y-worker-b", "a11y-worker-c"]);
  assert.equal(names.stubArgv, null);
  const all = render({ balance: "true" });
  assert.equal(all.status, 0, all.output);
  assert.equal(all.selected?.length, 4);
  assert.equal(all.stubArgv, null);
});

test("a resolver that fails fails the run: there is no fall-back to the unbalanced selection", { skip }, () => {
  const run = render({ balance: "true", extras: ["-e", "workers=ready"], chosen: "not json" as never });
  assert.notEqual(run.status, 0, run.output);
  assert.equal(run.selected, null);
});

test("the option must be a literal boolean: the string \"false\" is refused, not read as set", { skip }, () => {
  const run = render({ balance: "\"false\"", extras: ["-e", "workers=2"] });
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /not `true` or `false`/);
});

// ---------------------------------------------------------------------------------------------------------
// Text pins: what no rendering above can show.
// ---------------------------------------------------------------------------------------------------------

const declaredBalance = (text: string) => /^ {4}lab_dispatch_balance: (\S+)\s*$/m.exec(text)?.[1] ?? null;

test("`workers` is still a caller parameter, so the playbook still passes `-e workers=` through", () => {
  const params = /lab_caller_params: \[([^\]]*)\]/.exec(CATALOGUE)?.[1] ?? "";
  assert.ok(params.length > 0, "found no `lab_caller_params`, so the pin examined nothing");
  assert.ok(params.split(",").map((name) => name.trim()).includes("workers"));
});

test("the shipped example turns the option OFF, and the reader can tell off from on (the control)", () => {
  assert.equal(declaredBalance(EXAMPLE), "false");
  assert.equal(declaredBalance(EXAMPLE.replace("lab_dispatch_balance: false", "lab_dispatch_balance: true")), "true");
  assert.equal(declaredBalance("all:\n  children:\n"), null);
});

test("the lifted selection really contains the balanced tasks (the positive control for the rendered tests)", () => {
  for (const name of ["The balance option is a literal true or false", "Choose the least-loaded ready workers",
    "What it chose is what was taken"]) {
    assert.ok(LIFTED.includes(name), `${name} is not in the tasks the rendered tests run`);
  }
});

test("the loader the playbook looks for is the one `control-host-install.yml` asserts is installed", () => {
  const installed = /^\s*control_tsx_loader:\s*(\S+)\s*$/m.exec(
    readFileSync(new URL("../ansible/control-host-install.yml", import.meta.url), "utf8"))?.[1];
  assert.ok(installed, "found no control_tsx_loader, so the pin examined nothing");
  const looked = /name: Is the control plane's TypeScript loader here[\s\S]*?path: (\S+)/.exec(CATALOGUE)?.[1];
  assert.equal(looked, installed);
});

// #1086: reached through a symlink (npm's .bin, a staged tmpdir), the file must still RUN. The symlink-blind
// guard skipped `cli` and exited 0 with no output, which `lab-job.yml` would read as an empty choice.
const NODE_RUNS_TS = (() => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-ts-"));
  try {
    writeFileSync(join(dir, "probe.ts"), "const n: number = 1;\nprocess.exit(n - 1);\n");
    return spawnSync(process.execPath, [join(dir, "probe.ts")]).status === 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
})();

test("run through a symlink the CLI still runs: a bad request is a usage error, not a silent exit 0",
  { skip: NODE_RUNS_TS ? false : "this node cannot run a .ts file directly -- an honest skip, not a pass" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-link-"));
    try {
      const link = join(dir, "fleet-dispatch.ts");
      symlinkSync(fileURLToPath(new URL("./fleet-dispatch.ts", import.meta.url)), link);
      const run = spawnSync(process.execPath, [link, "--request=nonsense", "--pool=[]"], { encoding: "utf8" });
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /--request is `ready` or a whole number/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
