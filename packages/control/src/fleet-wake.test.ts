// The magic packet is the entire mechanism, and it is the one part that cannot be tested against a real
// machine from here — so it is tested against the specification instead. A wrong packet fails silently:
// the box simply never wakes, which is indistinguishable from a firmware setting being off.
import { test } from "node:test";
import assert from "node:assert/strict";

import { magicPacket, inventoryPathFor } from "./fleet-wake.mjs";

test("a magic packet is 6 x 0xFF then the MAC sixteen times", () => {
  const packet = magicPacket("00:1a:2b:3c:4d:5e");
  assert.equal(packet.length, 102, "6 + 16 * 6");
  assert.deepEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  for (let i = 0; i < 16; i += 1) {
    assert.deepEqual([...packet.subarray(6 + i * 6, 12 + i * 6)], [0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e],
      `repetition ${i} must be the target MAC`);
  }
});

test("separator and case do not matter — the same machine is the same packet", () => {
  // inventory.yml is hand-edited and a MAC gets pasted in whatever form the firmware showed it.
  const canonical = magicPacket("00:1a:2b:3c:4d:5e");
  for (const form of ["00-1A-2B-3C-4D-5E", "001a2b3c4d5e", "00:1A:2b:3C:4d:5E"]) {
    assert.deepEqual(magicPacket(form), canonical, `${form} should build the same packet`);
  }
});

test("anything that is not a MAC is refused, not padded into a packet nobody will answer", () => {
  // Silently sending a malformed packet is the worst outcome: it looks like it worked and the box never
  // comes back, which reads as a firmware problem on a machine you may have to walk to.
  for (const bad of ["", "not-a-mac", "00:1a:2b:3c:4d", "00:1a:2b:3c:4d:5e:6f"]) {
    assert.throws(() => magicPacket(bad), /not a MAC address/, `${bad} should be refused`);
  }
});

// --- #1683: the DURABLE inventory copy is tried first, matching ansible.cfg's own stated precedence ---

test("#1683: when the durable copy exists, it wins -- no checkout inventory.yml needed at all", () => {
  const path = inventoryPathFor({
    installed: "/etc/a11ign/inventory.yml", inTree: "/checkout/packages/control/ansible/inventory.yml",
    exists: (p) => p === "/etc/a11ign/inventory.yml",
  });
  assert.equal(path, "/etc/a11ign/inventory.yml");
});

test("#1683: with no durable copy, the in-tree checkout path is the fallback -- today's exact behaviour, unchanged", () => {
  const path = inventoryPathFor({
    installed: "/etc/a11ign/inventory.yml", inTree: "/checkout/packages/control/ansible/inventory.yml",
    exists: () => false,
  });
  assert.equal(path, "/checkout/packages/control/ansible/inventory.yml");
});

test("#1683 MUTATION TARGET: the durable path must be CHECKED, not assumed -- a machine with neither must "
  + "still fall through to the in-tree path (main()'s own ENOENT refusal reads it), never claim the "
  + "durable one exists unconditionally", () => {
  let checked = "";
  const path = inventoryPathFor({
    installed: "/etc/a11ign/inventory.yml", inTree: "/checkout/packages/control/ansible/inventory.yml",
    exists: (p) => { checked = p; return false; },
  });
  assert.equal(checked, "/etc/a11ign/inventory.yml", "the durable path must actually be asked about");
  assert.equal(path, "/checkout/packages/control/ansible/inventory.yml");
});

test("#1683: the real defaults name the same durable path ansible.cfg's own first-listed source does, "
  + "and the real in-tree path this file always read", () => {
  const path = inventoryPathFor({ exists: () => false });
  assert.match(path, /packages\/control\/ansible\/inventory\.yml$/);
});
