// The control half of fleet-layer/edge-pin-parity.test.ts (a11ign/a11ign#5345): the role-vs-bootstrap parity and lag tests read control's own
// `defaults/main.yml`. The three bootstrap-only tests moved to a11ign/screenreader-fleet (src/edge-pin-parity.test.ts, #5350).
/**
 * THE EDGE PIN EXISTS IN TWO PLACES, AND THEY MUST NOT DRIFT.
 *
 * `roles/worker/tasks/edge-version.yml` is the tested copy and the one `provisionRevision` hashes.
 * `bootstrap-windows-worker.ps1` now carries a port of it, because a pin that arrives after the box has
 * updated itself is not a pin — which is what happened to a11y-worker-7 on 2026-09-04. Nothing in first
 * boot mentioned Edge; the box came up with a network, Edge updated itself to 152 while `npm install` was
 * still running, and the role then refused correctly: Chromium will not install over a newer build and
 * Windows will not let Edge be uninstalled. One box reimaged.
 *
 * A fact stated twice is this repo's most-repeated defect, and the remedies in order of preference are:
 * delete a copy, derive one from the other, or PIN THEM EQUAL. The first two are unavailable — the
 * bootstrap runs on a box with no Ansible, before the fleet can reach it, and reading `defaults/main.yml`
 * would mean a YAML parser in PowerShell at first boot. So: pinned equal, here.
 *
 * The VERSION is what must match. The prose need not, and deliberately so — the role explains itself to an
 * operator reading a playbook, the bootstrap to one reading a console.
 *
 * THE BOOTSTRAP LIVES IN ANOTHER REPOSITORY (screenreader-fleet), laid here at the tag the core's lockfile
 * pins, so a pin move in THIS repository cannot move it in the same pull request (a11ign#4939 moved the role
 * to 155.0.4283.45 while the laid bootstrap read 152.0.4191.66). `BOOTSTRAP_LAG` is the one declared way
 * for the two to differ: it names a WHOLE earlier pin (version, URL and hash together), it accepts nothing
 * else, and `lagIsStale` makes the test fail the moment the bootstrap carries the role's pin, so the
 * allowance cannot outlive the thing it excuses. Nothing here relaxes the other three assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../../..");
const DEFAULTS = readFileSync(resolve(REPO, "packages/control/ansible/roles/worker/defaults/main.yml"), "utf8");
const BOOTSTRAP = readFileSync(
  resolve(REPO, "packages/worker-fleet/src/provisioning/bootstrap-windows-worker.ps1"), "utf8");

const fromRole = (key: string) =>
  new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "m").exec(DEFAULTS)?.[1]?.trim();

interface Pin { version: string; url: string; sha256: string }

/**
 * The pin the bootstrap may still carry until the fleet layer's own repository moves it, or `undefined` once it
 * has. It is `undefined` since the fleet layer is pinned at 0.10.2 (a11ign#5312), whose bootstrap carries the role's whole pin
 * (it was 152.0.4191.66, the role's pin until a11ign#4939). Declare one here only for a lag that is real: `lagIsStale` fails
 * the test that leaves one in once the bootstrap catches up.
 */
const BOOTSTRAP_LAG: Pin | undefined = undefined;

const carriesWhole = (script: string, pin: Pin) => [pin.version, pin.url, pin.sha256].every((v) => script.includes(v));
const acceptedPins = (role: Pin, lag: Pin | undefined): Pin[] => (lag ? [role, lag] : [role]);
/** A declared lag the bootstrap no longer needs: the script carries the role's whole pin and the allowance is still there. */
const lagIsStale = (script: string, role: Pin, lag: Pin | undefined) => lag !== undefined && carriesWhole(script, role);

function rolePin(): Pin {
  const [version, url, sha256] = ["worker_edge_version", "worker_edge_msi_url", "worker_edge_msi_sha256"].map(fromRole);
  assert.ok(version && url && sha256, "the role defaults no longer declare the whole Edge pin — this test examines nothing");
  return { version, url, sha256 };
}

test("the bootstrap pins the SAME Edge build the role does", () => {
  const role = rolePin();
  assert.ok(acceptedPins(role, BOOTSTRAP_LAG).some((pin) => BOOTSTRAP.includes(pin.version)),
    `the role pins Edge ${role.version} and the bootstrap does not mention it (nor the declared lag). A box `
    + "built from the bootstrap would come up on a different build from the fleet, and `browserVersion` is "
    + "FIRST in `fleet-consistency`'s MUST_MATCH — so every capture run would refuse to start, on all boxes.");
});

test("the bootstrap fetches the SAME MSI, verified by the SAME hash", () => {
  // The URL is a delivery endpoint: what it serves can change under a stable address, so the hash is the
  // real pin and a copy that checks a different one is not checking anything.
  const role = rolePin();
  for (const key of ["url", "sha256"] as const) {
    assert.ok(acceptedPins(role, BOOTSTRAP_LAG).some((pin) => BOOTSTRAP.includes(pin[key])),
      `${key} differs between the role and the bootstrap — they would install different bytes`);
  }
  // One WHOLE pin, never a version from one build and a hash from another.
  assert.ok(acceptedPins(role, BOOTSTRAP_LAG).some((pin) => carriesWhole(BOOTSTRAP, pin)),
    "the bootstrap carries parts of two different pins: version, URL and hash must come from the same build");
});

test("a declared bootstrap lag is deleted once the bootstrap carries the role's pin", () => {
  assert.ok(!lagIsStale(BOOTSTRAP, rolePin(), BOOTSTRAP_LAG),
    "the bootstrap now carries the role's whole pin, so BOOTSTRAP_LAG excuses nothing. Delete it: left in, it "
    + "would silently accept the NEXT bootstrap that falls behind.");
});

const SHA256_HEX_LENGTH = 64;

test("control: the lag accepts exactly its own whole pin and nothing else", () => {
  const role: Pin = { version: "155.0.4283.45", url: "https://example.test/role.msi", sha256: "a".repeat(SHA256_HEX_LENGTH) };
  const lag: Pin = { version: "152.0.4191.66", url: "https://example.test/lag.msi", sha256: "b".repeat(SHA256_HEX_LENGTH) };
  const script = (pin: Pin) => `${pin.version} ${pin.url} ${pin.sha256}`;
  const accepted = (text: string) => acceptedPins(role, lag).some((pin) => carriesWhole(text, pin));
  assert.ok(accepted(script(role)) && accepted(script(lag)), "a whole role pin or a whole lag pin must pass");
  assert.ok(!accepted(`${lag.version} ${role.url} ${role.sha256}`), "a version from one pin and bytes from another must fail");
  assert.ok(!accepted(script({ ...lag, version: "153.0.0.1" })), "a third version must fail");
  assert.ok(!acceptedPins(role, undefined).some((pin) => carriesWhole(script(lag), pin)), "with no lag declared the old pin must fail");
  assert.ok(lagIsStale(script(role), role, lag), "a caught-up bootstrap with the lag still declared must read as stale");
  assert.ok(!lagIsStale(script(lag), role, lag), "a lagging bootstrap is not stale: that is what the lag is for");
});
