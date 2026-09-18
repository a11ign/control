// The interesting cases are the ones that only happen when something has already gone wrong, so they are
// tested without a network. The MOVED case is the one that cost real time: the worker drifted from .83 to
// .102 by DHCP, and probing the old address returned nothing — which is indistinguishable from a box that
// is switched off. That is the worst kind of staleness, because the fleet gets QUIETER as it happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { reconcile, inventoryHosts, normaliseMac, enrol, writeEnrolments } from "./fleet-discover.mjs";
import { workersFromInventory } from "../../worker-fleet/src/fleet-env.mjs";

const health = { code: "abc", environment: { screenReaderVersion: "2026.1.1" } };

test("a worker at its declared address is OK", () => {
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01", health }]);
  assert.equal(found[0].state, "ok");
});

test("a worker that MOVED is matched by MAC, not by address", () => {
  // Matching on IP is exactly what broke. The MAC comes from ARP after the box answers, so it needs no
  // change to /health — which matters, because a new field there would change codeVersion() and mark the
  // entire fleet stale.
  const found = reconcile(
    [{ name: "w1", host: "203.0.113.83", mac: "aa:bb:cc:dd:ee:01" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01", health }]);
  assert.equal(found[0].state, "moved");
  assert.equal(found[0].foundAt, "REDACTED-INTERNAL-ADDRESS");
});

test("a box at a worker's declared address with a DIFFERENT mac is NOT that worker", () => {
  // DHCP moved a worker from .83 to .102 once; if the freed address is later leased to another worker
  // while the first box is powered down, an IP-only match reports the DEAD machine as healthy, carrying
  // the other box's /health. Measured before the fix: w1 "ok", w2 "moved to REDACTED-INTERNAL-ADDRESS" -- one physical
  // box, two findings, and the healthy-looking one does not exist.
  //
  // The pre-existing "at its declared address is OK" test passes a MATCHING mac, so it pinned the shape
  // the code produced and could never see this. That is why the case is here and not folded into it.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" },
     { name: "w2", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:02" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:02", health }]);
  const w1 = found.find((f) => f.name === "w1");
  const w2 = found.find((f) => f.name === "w2");
  assert.equal(w1?.state, "absent");
  assert.equal(w2?.state, "moved");
  assert.equal(w2?.foundAt, "REDACTED-INTERNAL-ADDRESS");
  assert.equal(found.length, 2, "one physical box must not produce a third finding");
  // "not answering" would be FALSE of REDACTED-INTERNAL-ADDRESS — something is there, it is just not w1. Making the
  // state correct while leaving the sentence wrong is this repo's "diagnostic that cannot report
  // itself", so the finding carries what was found at the address.
  assert.equal(w1?.occupiedBy, "aa:bb:cc:dd:ee:02");
});

test("a declared worker with NO mac still matches on address", () => {
  // An inventory entry with no `mac:` is the normal state for a box nobody has read the address off --
  // inventory.yml says so, and enrolment deliberately records such a box. So an absent MAC must mean
  // "cannot check", never "does not match": the strict version of the fix above reported every
  // un-enrolled worker absent, which is the fleet going quiet, the fault this module exists to prevent.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: null }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:09", health }]);
  assert.equal(found[0].state, "ok");
});

test("ARP missing the mac of a box that just answered still matches on address", () => {
  // `macOf` returns null whenever ARP has no entry, which happens. The unknown side is the DISCOVERED
  // one here rather than the declared one, and it must be just as forgiving.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: null, health }]);
  assert.equal(found[0].state, "ok");
});

test("a worker that is off is ASLEEP, not a failure", () => {
  // This fleet is meant to be powered down between runs; doctor already refuses to call that a fault.
  const found = reconcile([{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }], []);
  assert.equal(found[0].state, "absent");
});

test("something answering that we do not know about is UNKNOWN, never adopted", () => {
  // The retired Proxmox VM answers /health on this LAN. A tool that adopted whatever replied would have
  // quietly added it to the fleet and produced evidence from a machine nobody provisioned.
  const found = reconcile([], [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "f2:24:19:33:b0:d3", health }]);
  assert.equal(found[0].state, "unknown");
  assert.equal(found[0].mac, "f2:24:19:33:b0:d3");
});

test("a moved worker is not ALSO reported as unknown", () => {
  // Otherwise one machine produces two findings and the count is a lie.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01" }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01", health }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].state, "moved");
});

test("without a MAC a moved worker cannot be recognised, and is not guessed at", () => {
  // It reports absent + unknown, which is honest: we genuinely cannot tell whether that is the same box.
  const found = reconcile(
    [{ name: "w1", host: "REDACTED-INTERNAL-ADDRESS", mac: null }],
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:01", health }]);
  assert.deepEqual(found.map((f) => f.state).sort(), ["absent", "unknown"]);
});

test("MAC formats are normalised, so 00-1A-2B and 00:1a:2b are one machine", () => {
  assert.equal(normaliseMac("00-1A-2B-3C-4D-5E"), "00:1a:2b:3c:4d:5e");
  assert.equal(normaliseMac("001a2b3c4d5e"), "00:1a:2b:3c:4d:5e");
  assert.equal(normaliseMac(""), null);
  assert.equal(normaliseMac("nonsense"), null);
});

// Reads the EXAMPLE, deliberately, not the real inventory -- the real one is gitignored (real addresses,
// restored from the secrets store at bring-up) and does not exist in CI or a fresh clone. This test only
// checks the SHAPE (a host exists, its address is address-shaped), which the example preserves by design
// -- see inventory.example.yml's own header and inventory-example-parity.test.ts, which is what proves the
// example is still equivalent to the real file for exactly this purpose. Do not re-point this at
// inventory.yml: it would pass locally and fail everywhere the real file is absent.
test("the example inventory parses, and its hosts carry an address", () => {
  const text = readFileSync(fileURLToPath(new URL("../ansible/inventory.example.yml", import.meta.url)), "utf8");
  const hosts = inventoryHosts(text);
  assert.ok(hosts.length >= 1, "the shipped inventory should declare at least one worker");
  for (const h of hosts) assert.match(h.host, /^[\d.]+$/);
});

// ---------------------------------------------------------------------------------------------------
// Enrolment has to land in the WORKER group, and the only way to know is to read it back with the
// reader a run actually uses. These two modules were independently correct and jointly broken for the
// length of one commit on 2026-08-21: `fleet-env.mjs` became group-aware, `inventory.yml` gained the
// control-plane group, and `enrol` was still appending to the END OF THE FILE — so the next enrolled
// worker would have landed in `a11y_lab` and been correctly ignored by the reader. Provisioned,
// updated, never dispatched to, and nothing to say so.

// Reads inventory.example.yml, deliberately -- this needs a REALISTIC multi-group inventory to exercise
// enrol()'s group-awareness against, and the example carries the same group structure as the real file
// (see inventory-example-parity.test.ts). It never reads the group's ADDRESSES, so the placeholder values
// cost nothing here. inventory.yml itself is gitignored and would make this whole file fail to import on
// a fresh clone or in CI, which is exactly the shape a MODULE-LEVEL readFileSync produces -- one file
// failing at import time rather than one test failing at run time.
const EXAMPLE_INVENTORY = readFileSync(
  fileURLToPath(new URL("../ansible/inventory.example.yml", import.meta.url)), "utf8");

test("an enrolled worker is visible to the reader a RUN uses, not merely present in the file", () => {
  const { text, added } = enrol(EXAMPLE_INVENTORY, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }],
    "2026-08-21");

  assert.equal(added.length, 1);
  // The real assertion: parsed back, not grepped for. Being in the file is not the same as being a worker.
  assert.ok(workersFromInventory(text).includes("http://REDACTED-INTERNAL-ADDRESS:8765"),
    "an enrolled worker must be in the worker group — appending past the last group hides it");
});

test("enrolment does not disturb the workers already declared", () => {
  const before = workersFromInventory(EXAMPLE_INVENTORY);
  const { text } = enrol(EXAMPLE_INVENTORY, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }],
    "2026-08-21");

  assert.deepEqual(workersFromInventory(text).filter((w) => !w.includes("REDACTED-INTERNAL-ADDRESS")), before);
});

test("enrolment does not turn the control plane into a capture worker", () => {
  // The lab is in the inventory so there is one source of truth for what exists. It must never become
  // something a run dispatches capture cases to, before or after an enrolment.
  const { text } = enrol(EXAMPLE_INVENTORY, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }],
    "2026-08-21");

  for (const url of workersFromInventory(text)) {
    assert.ok(!url.includes("203.0.113.79"), `the lab leaked into the fleet as ${url}`);
  }
});

test("enrolling nothing changes nothing", () => {
  const { text, added } = enrol(EXAMPLE_INVENTORY, [], "2026-08-21");
  assert.equal(added.length, 0);
  assert.equal(text, EXAMPLE_INVENTORY);
});

test("an inventory with no worker group REFUSES the enrolment rather than appending anyway", () => {
  assert.throws(
    () => enrol("all:\n  children:\n    a11y_lab:\n      hosts:\n        a11y-lab:\n          ansible_host: 1.2.3.4\n",
      [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }], "2026-08-21"),
    /declares no `a11y_workers:` group/);
});

test("inventoryHosts is group-aware too, or discover reports the lab as a sleeping worker", () => {
  // This module has its own host reader with its own regexes, and it matched host names at exactly eight
  // spaces of indentation — which is what the control-plane entry uses. So it returned the lab as a fifth
  // worker and `reconcile` called it ASLEEP?, probing :8765 on a box that has no worker and never will.
  const hosts = inventoryHosts(EXAMPLE_INVENTORY);

  assert.ok(hosts.length >= 4, "the real workers must still be found");
  for (const host of hosts) {
    assert.notEqual(host.name, "a11y-lab", "the control plane is not a capture worker");
    assert.notEqual(host.host, "203.0.113.79", "the control plane is not a capture worker");
  }
  // And the MACs still parse — wake.yml sends its magic packet to these, and a host read without its mac
  // is SKIPPED by wake rather than woken.
  assert.ok(hosts.every((h) => h.mac), "every declared worker still has its mac");
});

// ---------------------------------------------------------------------------------------------------
// #1684: `--enroll` writes to the IN-TREE inventory unconditionally (the "draft for a human to review"
// candidate off #1684's own list, needing no new write capability), while the READ half now resolves
// the durable copy first (#1683's own precedence, shared via control-plane-fleet.mjs). Those two paths
// can disagree -- a worker already declared in the durable copy but never synced into the in-tree draft
// -- so `enrol`'s duplicate check takes a THIRD input, `alsoKnown`, for exactly that gap.

test("#1684: a mac known only via alsoKnown (the durable copy) is treated as a MOVE, not re-enrolled "
  + "under a second, colliding name", () => {
  const { text, added, skipped } = enrol(EXAMPLE_INVENTORY,
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }], "2026-08-21",
    [{ name: "a11y-worker-9", mac: "aa:bb:cc:dd:ee:ff" }]);

  assert.deepEqual(added, [], "already known elsewhere -- nothing new to add");
  assert.deepEqual(skipped, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff" }]);
  assert.equal(text, EXAMPLE_INVENTORY, "skipped means the in-tree draft is untouched");
});

test("#1684: alsoKnown also protects the NAME a fresh enrolment picks, not only the mac dedup", () => {
  // Without folding alsoKnown's names into nextWorkerName's search, a worker whose mac IS new could still
  // be handed a name the durable copy already uses for a different machine.
  const declaredNames = inventoryHosts(EXAMPLE_INVENTORY).map((h) => h.name);
  const { text, added } = enrol(EXAMPLE_INVENTORY,
    [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:fe", health }], "2026-08-21",
    declaredNames.map((name) => ({ name, mac: null })).concat([{ name: "a11y-worker-99", mac: null }]));

  assert.equal(added.length, 1);
  assert.equal(added[0].name, "a11y-worker-100", "must skip past every name alsoKnown named too");
  assert.ok(workersFromInventory(text).includes("http://REDACTED-INTERNAL-ADDRESS:8765"));
});

test("#1684 MUTATION TARGET: with no alsoKnown, enrol behaves exactly as it always did -- the new "
  + "parameter must default to empty, never silently require a caller to pass it", () => {
  const withDefault = enrol(EXAMPLE_INVENTORY, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }], "2026-08-21");
  const withExplicitEmpty = enrol(EXAMPLE_INVENTORY, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }], "2026-08-21", []);
  assert.deepEqual(withDefault, withExplicitEmpty);
});

test("#1684: --enroll refuses cleanly when the in-tree write target does not exist, rather than an "
  + "uncaught ENOENT stack -- the state #1684's own Open-check measured on the lab", () => {
  const missing = fileURLToPath(new URL("../ansible/no-such-inventory.yml", import.meta.url));
  const result = writeEnrolments(missing, [{ ip: "REDACTED-INTERNAL-ADDRESS", mac: "aa:bb:cc:dd:ee:ff", health }]);
  assert.deepEqual(result, { added: [], skipped: [] });
});
