/**
 * a11ign#5014: the fleet lock, proven offline. The control plane's filesystem is a directory of this machine's: the
 * transport runs the REAL command (the real `flock`, the real `node`) with the control plane's checkout path
 * rewritten to the sandbox, so the address the code names is the address that is exercised and nothing here reaches
 * a network or `/root` (the resource ban bars a live run, and `fleet-wake.test.ts`'s `controlPlane()` is the shape).
 */
// no-token: gh -- nothing here spawns `gh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import {
  FLEET_LOCK_PATH, LOCK_GRACE_MS, takeFleetLock, readFleetLock, expireFleetLock, parseFleetLock, fleetLockRefusal,
  lockReadCommand,
} from "./fleet-lock.ts";

const HOUR = 3_600_000;
const T0 = 1_760_000_000_000;

function controlPlane() {
  const root = mkdtempSync(join(tmpdir(), "fleet-lock-"));
  const commands: string[] = [];
  const rewrite = (command: string) => command.replaceAll(CONTROL_PLANE_CHECKOUT_PATH, root);
  const transport = (command: string) => {
    commands.push(command);
    return execFileSync("sh", ["-c", rewrite(command)], { encoding: "utf8" });
  };
  const file = FLEET_LOCK_PATH.replace(CONTROL_PLANE_CHECKOUT_PATH, root);
  return {
    root, commands, transport, file, rewrite,
    seed: (text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); },
    onDisk: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
    reading: (now: number) => readFleetLock(now, { transport }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const provision = (extra: Record<string, unknown> = {}) => ({ operation: "provision-role.yml", longestRunMs: 4 * HOUR, now: T0, holder: "agents:100", ...extra });

test("#5014 take: writes who, what and until when, where the timer reads it, and the file is the reading", () => {
  const cp = controlPlane();
  try {
    assert.deepEqual(cp.reading(T0), { state: "none" }, "positive control: before any take there is no lock, so the held below is the take's doing");
    const outcome = takeFleetLock({ ...provision(), transport: cp.transport });
    assert.deepEqual(outcome, { taken: true, replacedUnreadable: false,
      lock: { operation: "provision-role.yml", holder: "agents:100", takenAt: T0, expiresAt: T0 + 4 * HOUR } });
    assert.deepEqual(JSON.parse(cp.onDisk() as string), outcome.taken && outcome.lock);
    const reading = cp.reading(T0 + 1);
    assert.equal(reading.state, "held");
    assert.ok(cp.commands.every((command) => command.includes(CONTROL_PLANE_CHECKOUT_PATH + "/runs/fleet-lock.json")),
      "every step names the control plane's own `runs/fleet-lock.json`, not the cwd's");
  } finally { cp.dispose(); }
});

test("#5014 read: held until expiresAt, stale AT it (and ignored), and the boundary is one millisecond", () => {
  const cp = controlPlane();
  try {
    takeFleetLock({ ...provision(), transport: cp.transport });
    assert.equal(cp.reading(T0 + 4 * HOUR - 1).state, "held", "the last millisecond of the longest run is still held");
    const stale = cp.reading(T0 + 4 * HOUR);
    assert.equal(stale.state, "stale", "the lock a run never released stops counting at its operation's longest run");
    assert.equal(stale.state === "stale" && stale.lock.operation, "provision-role.yml", "and names what it was");
  } finally { cp.dispose(); }
});

test("#5014 read: unreadable is its own answer, in every way a file can be unreadable, and a transport that fails is not `none`", () => {
  const cp = controlPlane();
  const logged: string[] = [];
  try {
    for (const [what, text] of [["not JSON", "{ half a file"], ["JSON that is not a lock", "{\"operation\":\"deploy.yml\"}"],
      ["a number where a time is", JSON.stringify({ operation: "a", holder: "b", takenAt: "yesterday", expiresAt: 5 })]] as const) {
      cp.seed(text);
      const reading = readFleetLock(T0, { transport: cp.transport, log: (line) => logged.push(line) });
      assert.equal(reading.state, "unreadable", what);
    }
    assert.equal(logged.length, 3, "each one said so, since a fleet kept on for a reason nobody can see is the quiet failure");
    cp.seed("");
    assert.deepEqual(cp.reading(T0), { state: "none" }, "positive control: an empty file is no lock, so the three above were refused for what they held");
    const unreachable = readFleetLock(T0, { transport: () => { throw new Error("ssh: no route to host"); }, log: (line) => logged.push(line) });
    assert.equal(unreachable.state, "unreadable", "an unreachable control plane is not an answer that nobody holds the fleet");
    assert.match(logged.at(-1) ?? "", /no route to host/);
  } finally { cp.dispose(); }
});

test("#5014 take: a second operation is refused while a fresh lock is held, and the file is byte-for-byte untouched", () => {
  const cp = controlPlane();
  try {
    takeFleetLock({ ...provision(), transport: cp.transport });
    const before = cp.onDisk();
    const refused = takeFleetLock({ operation: "deploy.yml", longestRunMs: HOUR / 2, now: T0 + HOUR, holder: "laptop:7", transport: cp.transport });
    if (refused.taken) assert.fail("a second operation took a fresh lock held by another");
    assert.equal(refused.held.operation, "provision-role.yml", "and it names the operation that holds");
    assert.equal(cp.onDisk(), before, "a refusal writes nothing");
    const words = fleetLockRefusal({ held: refused.held, wanted: "deploy.yml", now: T0 + HOUR });
    assert.match(words, /^REFUSING deploy\.yml: .*provision-role\.yml.*agents:100.*not ended/s);
  } finally { cp.dispose(); }
});

test("#5014 take: the controls -- the same operation takes again, a different one takes once the lock is stale, a held lock of a crashed run is replaced", () => {
  const cp = controlPlane();
  try {
    takeFleetLock({ ...provision(), transport: cp.transport });
    const again = takeFleetLock({ ...provision({ now: T0 + HOUR, holder: "laptop:7" }), transport: cp.transport });
    assert.equal(again.taken, true, "the next attempt of a sequence, from another session after a crash that never ended its lock");
    assert.equal(again.taken && again.lock.expiresAt, T0 + 5 * HOUR);
    const later = takeFleetLock({ operation: "deploy.yml", longestRunMs: HOUR / 2, now: T0 + 5 * HOUR, holder: "laptop:9", transport: cp.transport });
    assert.equal(later.taken, true, "a lock past its expiresAt refuses nobody");
    assert.equal(later.taken && later.lock.operation, "deploy.yml");
  } finally { cp.dispose(); }
});

test("#5014 end: the unit's end SHORTENS the expiry and does not clear it, and only to the grace", () => {
  const cp = controlPlane();
  try {
    takeFleetLock({ ...provision(), transport: cp.transport });
    const ended = expireFleetLock({ operation: "provision-role.yml", holder: "agents:100", now: T0 + 10 * 60_000, transport: cp.transport });
    assert.equal(ended.ended, true);
    const lock = JSON.parse(cp.onDisk() as string);
    assert.equal(lock.expiresAt, T0 + 10 * 60_000 + LOCK_GRACE_MS, "now + the grace, not the four hours");
    assert.ok(lock.expiresAt < T0 + 4 * HOUR, "shortened");
    assert.equal(lock.endedAt, T0 + 10 * 60_000);
    assert.equal(cp.reading(T0 + 10 * 60_000 + LOCK_GRACE_MS - 1).state, "held", "not cleared: the next attempt of the sequence meets awake boxes");
    assert.equal(cp.reading(T0 + 10 * 60_000 + LOCK_GRACE_MS).state, "stale", "and a finished sequence lets go on its own");
    assert.equal(LOCK_GRACE_MS, 30 * 60_000, "the row names thirty minutes");
  } finally { cp.dispose(); }
});

test("#5014 end: only the holder that took the lock shortens it", () => {
  const cp = controlPlane();
  try {
    takeFleetLock({ ...provision(), transport: cp.transport });
    const before = cp.onDisk();
    for (const [what, who] of [["another holder", { operation: "provision-role.yml", holder: "laptop:7" }],
      ["another operation", { operation: "deploy.yml", holder: "agents:100" }]] as const) {
      assert.deepEqual(expireFleetLock({ ...who, now: T0 + 60_000, transport: cp.transport }), { ended: false }, what);
      assert.equal(cp.onDisk(), before, `${what} left the lock as it was`);
    }
    const gone = controlPlane();
    try {
      assert.deepEqual(expireFleetLock({ operation: "provision-role.yml", holder: "agents:100", now: T0, transport: gone.transport }), { ended: false },
        "no file is `ended: false` and writes nothing");
      assert.equal(gone.onDisk(), null);
    } finally { gone.dispose(); }
  } finally { cp.dispose(); }
});

test("#5014 an ENDED lock still keeps auto-off off for its grace, and does not refuse a different operation (deploy after provision)", () => {
  const cp = controlPlane();
  try {
    takeFleetLock({ ...provision(), transport: cp.transport });
    expireFleetLock({ operation: "provision-role.yml", holder: "agents:100", now: T0 + HOUR, transport: cp.transport });
    assert.equal(cp.reading(T0 + HOUR + 1).state, "held");
    const next = takeFleetLock({ operation: "deploy.yml", longestRunMs: HOUR / 2, now: T0 + HOUR + 60_000, holder: "agents:101", transport: cp.transport });
    assert.equal(next.taken, true, "the ordinary sequence must not wait half an hour; positive control above: the same lock refused while running");
  } finally { cp.dispose(); }
});

test("#5014 take: a file that cannot be read is REPLACED and says so, never left to refuse every operation for ever", () => {
  const cp = controlPlane();
  try {
    cp.seed("{ half a file");
    const outcome = takeFleetLock({ ...provision(), transport: cp.transport });
    assert.deepEqual(outcome.taken && outcome.replacedUnreadable, true);
    assert.equal(cp.reading(T0).state, "held", "and what is on disk afterwards is a lock");
  } finally { cp.dispose(); }
});

test("#5014 take: two operations starting together leave ONE winner (the remote step reads, decides and writes under flock)", async () => {
  const cp = controlPlane();
  try {
    const recorded: string[] = [];
    for (const operation of ["deploy.yml", "provision-role.yml"]) {
      // The command only: the transport answers a fabricated lock so `takeFleetLock` returns, and the real step runs below, together.
      takeFleetLock({ operation, longestRunMs: HOUR, now: T0, holder: `${operation}:1`, path: FLEET_LOCK_PATH,
        transport: (command) => { recorded.push(command); return JSON.stringify({ taken: true, lock: { operation, holder: "x", takenAt: T0, expiresAt: T0 + HOUR } }); } });
    }
    const run = (command: string) => new Promise<string>((resolve, reject) => {
      const child = spawn("sh", ["-c", cp.rewrite(command)]);
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
    const answers = (await Promise.all(recorded.map(run))).map((text) => JSON.parse(text));
    assert.deepEqual(answers.map((a) => a.taken).sort(), [false, true], "exactly one of two simultaneous different operations took it");
  } finally { cp.dispose(); }
});

test("#5014 the remote step travels in single quotes and a path with anything but a plain absolute shape is refused before a shell sees it", () => {
  const commands: string[] = [];
  takeFleetLock({ ...provision(), transport: (command) => { commands.push(command); return JSON.stringify({ taken: true, lock: { operation: "a", holder: "b", takenAt: 1, expiresAt: 2 } }); } });
  assert.match(commands[0], /^mkdir -p "\$\(dirname '[^']+'\)" && flock '[^']+\.lock' node -e '[^']*' '[^']+' [A-Za-z0-9+/=]+$/,
    "no single quote can appear inside the script, since it travels inside a pair of them");
  for (const bad of ["runs/fleet-lock.json", "/root/a b/lock", "/root/x'; rm -rf /; '"]) {
    assert.throws(() => takeFleetLock({ ...provision(), path: bad, transport: () => "" }), /plain absolute path/, bad);
    assert.throws(() => lockReadCommand(bad), /plain absolute path/, bad);
  }
});

test("#5014 a transport that answers something else is an error, never a lock that was taken", () => {
  assert.throws(() => takeFleetLock({ ...provision(), transport: () => "" }), /not JSON/);
  assert.throws(() => takeFleetLock({ ...provision(), transport: () => "{\"taken\":true}" }), /neither taken nor refused/);
  assert.throws(() => expireFleetLock({ operation: "a", now: T0, transport: () => "[1]" }), /neither ended nor not|not an object|not JSON/);
});

test("#5014 parseFleetLock: a lock with an endedAt that is not a number is unreadable", () => {
  const good = { operation: "deploy.yml", holder: "h", takenAt: 1, expiresAt: 5, endedAt: 2 };
  assert.equal(parseFleetLock(JSON.stringify(good), 3).state, "held");
  assert.equal(parseFleetLock(JSON.stringify({ ...good, endedAt: "soon" }), 3).state, "unreadable");
});
