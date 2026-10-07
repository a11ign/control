/**
 * #3860: `fleet-watch` mirrors the auto-off record it read over ssh to a file `org-health` can read, because the
 * tick may not ssh and the agents host's own copy of the state path reads CLEAR through a standing refusal (#3846).
 *
 * Everything is driven with an injected reader and a temp directory; nothing here reaches the control plane.
 */
// no-token: gh -- nothing here spawns `gh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_OFF_MIRROR_PATH, AUTO_OFF_STATE_PATH, readAutoOffRefusal, readRefusalOrSay } from "./fleet-watch.mjs";

const refusal = { reason: "stale-checkout", detail: "2 files differ: a.mjs, b.mjs", at: 1_000 };

function inTempDir(body: (dir: string, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "a11y-auto-off-mirror-"));
  try {
    body(dir, join(dir, "fleet-auto-off-mirror.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the mirror path is a named constant beside the state path, under runs/", () => {
  // Joined rather than quoted whole: `dataset-paths.test.ts` reads a quoted `runs/<name>` as a dataset root resolved by hand,
  // and this is a fixed local file the control package owns, not one (the same ground `fleet-watch.mjs` is exempt on).
  assert.equal(AUTO_OFF_MIRROR_PATH, join("runs", "fleet-auto-off-mirror.json"));
  assert.notEqual(AUTO_OFF_MIRROR_PATH, AUTO_OFF_STATE_PATH);
});

test("a read that succeeded writes { readAt, record } with the record verbatim, a refusal and a `since` included", () => {
  inTempDir((_dir, path) => {
    const record = { idleSince: { "a11y-worker-2": 5 }, fetchedAt: 7, refusal, since: 900 };
    const got = readAutoOffRefusal(() => JSON.stringify(record), { readAt: 123_456, path });
    assert.deepEqual(got, refusal, "the refusal is still returned to the caller");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { readAt: 123_456, record });
  });
});

test("a record with no refusal mirrors `refusal: null`, which is a different statement from an old readAt", () => {
  inTempDir((_dir, path) => {
    readAutoOffRefusal(() => JSON.stringify({ idleSince: {}, refusal: null }), { readAt: 10, path });
    const mirror = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(mirror.readAt, 10);
    assert.equal(mirror.record.refusal, null);
  });
});

test("a missing state file on the control plane (`{}`) is written as `record: {}`", () => {
  inTempDir((_dir, path) => {
    assert.equal(readAutoOffRefusal(() => "{}", { readAt: 20, path }), null);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { readAt: 20, record: {} });
  });
});

test("a read that THROWS writes nothing, and leaves the previous mirror to age", () => {
  inTempDir((dir, path) => {
    const unreachable = () => { throw new Error("ssh: connect timed out"); };
    assert.throws(() => readAutoOffRefusal(unreachable, { readAt: 30, path }), /timed out/);
    assert.equal(existsSync(path), false, "no mirror where none was ever written");
    writeFileSync(path, JSON.stringify({ readAt: 1, record: {} }));
    assert.throws(() => readAutoOffRefusal(unreachable, { readAt: 40, path }), /timed out/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).readAt, 1, "the old readAt stands: 'I did not look'");
    assert.deepEqual(readdirSync(dir), ["fleet-auto-off-mirror.json"], "and no staging file is left behind");
  });
});

test("unparseable state text writes nothing: it is not a record", () => {
  inTempDir((_dir, path) => {
    assert.throws(() => readAutoOffRefusal(() => "ssh: banner garbage", { readAt: 50, path }));
    assert.equal(existsSync(path), false);
  });
});

test("the mirror is written through the injectable writer, once, to the given path", () => {
  inTempDir((dir, path) => {
    const calls: string[] = [];
    readAutoOffRefusal(() => "{}", {
      readAt: 60,
      path,
      write: (target, data) => {
        calls.push(target);
        assert.deepEqual(readdirSync(dir), [], "nothing exists at the moment of writing");
        writeFileSync(target, data);
      },
    });
    assert.deepEqual(calls, [path]);
  });
});

test("the DEFAULT writer replaces the file whole through a rename (no `.tmp` survives, an old mirror is replaced)", () => {
  inTempDir((dir, path) => {
    writeFileSync(path, "stale");
    readAutoOffRefusal(() => JSON.stringify({ refusal }), { readAt: 70, path });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).readAt, 70);
    assert.deepEqual(readdirSync(dir), ["fleet-auto-off-mirror.json"]);
  });
});

test("a mirror that cannot be written does not hide the refusal that was read", () => {
  const said: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
  try {
    const got = readAutoOffRefusal(() => JSON.stringify({ refusal }), {
      readAt: 80,
      path: "unused",
      write: () => { throw new Error("ENOSPC"); },
    });
    assert.deepEqual(got, refusal);
  } finally {
    console.error = original;
  }
  assert.match(said.join("\n"), /CANNOT WRITE the auto-off mirror: ENOSPC/);
});

test("with no mirror given, a read writes nothing (the existing callers are unchanged)", () => {
  const before = existsSync(AUTO_OFF_MIRROR_PATH) ? readFileSync(AUTO_OFF_MIRROR_PATH, "utf8") : null;
  readAutoOffRefusal(() => JSON.stringify({ refusal }));
  const after = existsSync(AUTO_OFF_MIRROR_PATH) ? readFileSync(AUTO_OFF_MIRROR_PATH, "utf8") : null;
  assert.equal(after, before);
});

test("the run's own reader (what `main` calls) mirrors a read with the clock's reading, and an unreachable host writes nothing and says so", () => {
  inTempDir((_dir, path) => {
    const got = readRefusalOrSay({ readState: () => JSON.stringify({ refusal }), path, now: () => 777 });
    assert.deepEqual(got, refusal);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { readAt: 777, record: { refusal } });

    const said: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
    try {
      const unreachable = () => { throw new Error("ssh: connect timed out"); };
      assert.equal(readRefusalOrSay({ readState: unreachable, path, now: () => 888 }), null);
    } finally {
      console.error = original;
    }
    assert.match(said.join("\n"), /CANNOT READ the auto-off refusal/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).readAt, 777, "the mirror still says when anyone last looked");
  });
});
