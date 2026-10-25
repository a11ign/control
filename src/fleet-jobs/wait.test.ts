/**
 * `fleet job wait` ALWAYS ENDS (A11-243). The wait loop is driven here with a clock and a route that the test controls, so the cases the service tests
 * cannot make on demand are shown: a service that stops answering mid-wait, one that is not there at the start, a poll that hangs, and a job that
 * ends in each way. Each case names the exit code it must give.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT, loadFleetEnv, main, parseFleetEnv, waitForJob } from "./cli.ts";
import type { Deps, Transport } from "./cli.ts";
import { viewJob } from "./view.ts";
import { STORE_VERSION } from "./types.ts";
import type { CaptureEntry, JobRequest, JobStateFile } from "./types.ts";

const ID = "fj-20261025T085815Z-315a1b";
const request: JobRequest = { version: STORE_VERSION, id: ID, label: "A11-243", pages: ["https://x.test/a", "https://x.test/b"], boxes: { kind: "count", count: 1 },
  passes: 1, body: {}, freeze: null, submittedBy: "a@h", submittedAt: "2026-10-25T08:58:15.000Z" };
const capture = (page: string, status: CaptureEntry["status"]): CaptureEntry => ({ page, pass: 1, file: "f", box: "w2", status });
const view = (state: JobStateFile["state"] | "queued", over: Partial<JobStateFile> = {}) => viewJob({
  request, cancelled: false, beat: null, now: 0,
  state: state === "queued" ? null : { version: STORE_VERSION, state, boxes: ["w2"], readings: {}, dropped: [], notes: [], startedAt: "2026-10-25T09:00:00.000Z",
    captures: [capture(request.pages[0]!, "done"), capture(request.pages[1]!, state === "done" ? "done" : "pending")], ...over },
});

/** A route whose answers are a script: each call takes the next step, and the last step repeats. */
type Step = { view: ReturnType<typeof view> } | { down: true } | { unknown: true };
function scripted(steps: Step[]): { transport: Transport; calls: () => number } {
  let calls = 0;
  const transport: Transport = () => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    if ("view" in step) return { file: "sh", args: ["-c", `printf '%s' '${JSON.stringify(step.view).replaceAll("'", "'\\''")}'`] };
    if ("unknown" in step) return { file: "sh", args: ["-c", "echo 'no job' >&2; exit 4"] };
    return { file: "sh", args: ["-c", "echo 'ssh: connect to host: Connection timed out' >&2; exit 255"] };
  };
  return { transport, calls: () => calls };
}

/** A clock that moves only when the loop sleeps, plus one second for each poll, so a test of a 60 s wait takes no time. */
function harness(steps: Step[]) {
  let clock = Date.parse("2026-10-25T09:00:00.000Z");
  const out: string[] = [];
  const err: string[] = [];
  const route = scripted(steps);
  const deps: Deps = {
    transport: (args) => { clock += 1000; return route.transport(args); },
    pollMs: 15_000, now: () => clock, sleep: async (ms) => { clock += ms; },
    out: (t) => out.push(t), err: (t) => err.push(t), readFile: () => "", submitter: () => "a@h", untar: async () => 0,
  };
  return { deps, out: () => out.join(""), err: () => err.join(""), route, clock: () => clock };
}

test("wait ends 0 when the job is done, and says how many captures failed", async () => {
  const t = harness([{ view: view("running") }, { view: view("running") }, { view: view("done") }]);
  assert.equal(await waitForJob(t.deps, ID, 600_000), EXIT.OK);
  assert.match(t.out(), new RegExp(`${ID} done: 2 captures, 0 failed`));
  assert.equal(t.route.calls(), 3, "it polled until done and no more");
});

test("wait ends 1 when the job failed, naming why", async () => {
  const t = harness([{ view: view("failed", { reason: "no box was left to capture 3 pages (a11y-worker-2: 3 captures in a row failed on it)" }) }]);
  assert.equal(await waitForJob(t.deps, ID, 600_000), EXIT.FAILED);
  assert.match(t.err(), /FAILED: no box was left to capture 3 pages \(a11y-worker-2: 3 captures in a row failed on it\)/);
});

test("wait ends 3 when the job was cancelled", async () => {
  const t = harness([{ view: view("running") }, { view: view("cancelled", { reason: "cancelled by request" }) }]);
  assert.equal(await waitForJob(t.deps, ID, 600_000), EXIT.CANCELLED);
  assert.match(t.err(), /was cancelled: cancelled by request; 1 of 2 captures had ended/);
});

test("wait ends 124 on timeout, printing the progress, what is left, and when the service was last reached", async () => {
  const t = harness([{ view: view("running") }]);
  assert.equal(await waitForJob(t.deps, ID, 60_000), 124);
  assert.match(t.err(), /TIMED OUT after 1m00s waiting for fj-/);
  assert.match(t.err(), /w2: 1\/2/, "the progress per box");
  assert.match(t.err(), /1 of 2 captures are left/, "what is left");
  assert.match(t.err(), /w2 has 1 of 2 left/);
  assert.match(t.err(), /the service was last reached at 2026-10-25T09:0/);
  assert.ok(t.clock() - Date.parse("2026-10-25T09:00:00.000Z") < 60_000 + 20_000, "it ended within a poll of the deadline");
});

test("a service that stops answering mid-wait does not hold the wait: it ends 124 at the deadline, saying the polls failed", async () => {
  const t = harness([{ view: view("running") }, { down: true }]);
  assert.equal(await waitForJob(t.deps, ID, 120_000), 124);
  assert.match(t.err(), /the service was last reached at /);
  assert.match(t.err(), /the polls since failed: ssh: connect to host: Connection timed out/);
  assert.ok(t.route.calls() >= 4, "failed polls are tried again until the deadline");
});

test("a service that cannot be reached at the start ends 2 at once, not after the whole timeout", async () => {
  const t = harness([{ down: true }]);
  assert.equal(await waitForJob(t.deps, ID, 7_200_000), EXIT.USAGE);
  assert.match(t.err(), /could not reach the fleet job service: ssh: connect to host/);
  assert.equal(t.route.calls(), 1);
});

test("an unknown job ends 2 at once", async () => {
  const t = harness([{ unknown: true }]);
  assert.equal(await waitForJob(t.deps, ID, 7_200_000), EXIT.USAGE);
  assert.match(t.err(), /no job/);
});

test("a job whose service has died still ends the wait: the timeout prints that the service is NOT RUNNING", async () => {
  const stale = viewJob({ request, cancelled: false, now: Date.parse("2026-10-25T09:10:00.000Z"),
    beat: { pid: 1, commit: "abcdef0123456789", startedAt: "2026-10-25T08:00:00.000Z", heartbeatAt: "2026-10-25T09:00:00.000Z" },
    state: { version: STORE_VERSION, state: "running", boxes: ["w2"], readings: {}, dropped: [], notes: [], startedAt: "2026-10-25T09:00:00.000Z", captures: [capture(request.pages[0]!, "pending")] } });
  const t = harness([{ view: stale }]);
  assert.equal(await waitForJob(t.deps, ID, 45_000), 124);
  assert.match(t.err(), /service: NOT RUNNING/);
});

test("the fleet.env that says how to reach the control plane is read, not run, and only for the names that matter", () => {
  const text = ["# a comment", "A11Y_PVE_KEY=/home/agent/.ssh/key", 'export A11Y_CONTROL_HOST_FILE="/home/agent/.config/a11ign/control-host"', "A11Y_CONTROL_HOST='10.0.0.2'", "SECRET=nope", "A11Y_PVE_KEY_EXTRA=x", "$(touch /tmp/pwned)"].join("\n");
  assert.deepEqual(parseFleetEnv(text), { A11Y_PVE_KEY: "/home/agent/.ssh/key", A11Y_CONTROL_HOST_FILE: "/home/agent/.config/a11ign/control-host", A11Y_CONTROL_HOST: "10.0.0.2" });
  const env: NodeJS.ProcessEnv = { HOME: "/h", A11Y_PVE_KEY: "already-set" };
  loadFleetEnv(env, (path) => { assert.equal(path, "/h/.config/a11ign/fleet.env"); return text; });
  assert.equal(env.A11Y_PVE_KEY, "already-set", "the environment wins");
  assert.equal(env.A11Y_CONTROL_HOST, "10.0.0.2");
  assert.equal(env.SECRET, undefined);
  loadFleetEnv({ HOME: "/h" }, () => { throw new Error("ENOENT"); });
});

test("a poll that hangs is cut at the deadline: the wait ends within a second or two of it, on the real clock", async () => {
  const running = JSON.stringify(view("running"));
  let calls = 0;
  const out: string[] = [];
  const deps: Deps = {
    transport: () => (++calls === 1 ? { file: "sh", args: ["-c", `printf '%s' '${running}'`] } : { file: "sleep", args: ["30"] }),
    pollMs: 100, now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out: () => {}, err: (t) => out.push(t), readFile: () => "", submitter: () => "a@h", untar: async () => 0,
  };
  const started = Date.now();
  assert.equal(await waitForJob(deps, ID, 2_000), 124);
  const took = Date.now() - started;
  assert.ok(took < 2_000 + 2_500, `a wait of 2 s with a hung poll ended after ${took} ms`);
  assert.match(out.join(""), /TIMED OUT/);
});

test("the `--` that `pnpm run fleet -- ...` hands the script is not a command", async () => {
  const t = harness([{ unknown: true }]);
  assert.equal(await main(["--", "job", "status", ID], t.deps), EXIT.USAGE);
  assert.match(t.err(), /no job/, "it reached the status call, so the command was read");
  const usage = harness([{ unknown: true }]);
  assert.equal(await main(["--", "nonsense"], usage.deps), EXIT.USAGE);
  assert.match(usage.err(), /^usage: fleet capture submit/);
});
