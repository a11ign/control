// The control half of fleet-layer/fleet-env.test.ts (a11ign/a11ign#5345): the two tests that read control's own ansible/ files.
// The reader's fixture and env tests moved to a11ign/screenreader-fleet's src/fleet-env-inventory.test.ts (a11ign#5350).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { workersFromInventory, portFromGroupVars, namedInventoryWorkers } from "../../../worker-fleet/src/fleet-env.ts";

// Reads inventory.example.yml, deliberately -- the REAL inventory.yml is gitignored (real addresses,
// restored from the secrets store at bring-up) and does not exist in CI or a fresh clone.
// inventory-example-parity.test.ts is what proves the example stays equivalent to the real file for this
// purpose; do not re-point this at inventory.yml, or it will pass locally and fail everywhere else.
test("the EXAMPLE inventory parses, and agrees with the real group vars", () => {
  // The fixtures above prove the reader's rules; this proves a real, committed file obeys them. A reader
  // that only ever runs against its own fixtures is a reader that has never met a file shaped like the one
  // it exists to read.
  const inventory = readFileSync(fileURLToPath(new URL("../../ansible/inventory.example.yml", import.meta.url)), "utf8");
  const groupVars = readFileSync(
    fileURLToPath(new URL("../../ansible/group_vars/a11y_workers.yml", import.meta.url)), "utf8");

  const workers = workersFromInventory(inventory, { port: portFromGroupVars(groupVars) });
  assert.ok(workers.length >= 1, "the shipped inventory should list at least the first bare-metal worker");
  for (const url of workers) assert.match(url, /^http:\/\/[\d.]+:\d+$/);
});

test("THE INVENTORY IS A FLEET DOCTOR CAN SEE, and it is named", () => {
  // `doctor` resolved A11Y_WORKERS, then the local UTM pool, then gave up — so on a Mac with any
  // registered VM it reported the DEPRECATED local guests and never inventory.yml. Measured on one
  // machine at one moment: doctor said "2 worker(s), all stopped — READY" while `worker:code` said
  // "checking 5 worker(s) from inventory.yml" and `fleet:status` showed those five BUSY with a corpus
  // run. Its next_command was `training:capture`, which would have captured on the wrong machines.
  //
  // Named, not numbered: `fleet-status.ts` records what an address-only report cost — ".224 is
  // a11y-worker-FIVE, so `fleet:sleep --limit=a11y-worker-4` put a healthy machine to sleep and left the
  // drifted one serving".
  //
  // inventory.example.yml, not the real inventory.yml -- the real one is gitignored (real addresses,
  // restored from the secrets store at bring-up) and this checkout would otherwise need it just to run
  // `npm test`. `inventory-example-parity.test.ts` is what keeps the example's shape (and therefore this
  // test's premise) honest.
  const workers = namedInventoryWorkers({
    inventoryPath: fileURLToPath(new URL("../../ansible/inventory.example.yml", import.meta.url)),
  });
  assert.ok(workers.length > 0, "this checkout declares a bare-metal fleet; the reader must find it");
  for (const { name, url } of workers) {
    assert.match(url, /^https?:\/\/[^/]+:\d+$/, "every entry is a usable worker address");
    assert.doesNotMatch(name, /^https?:\/\//,
      "a name is a name — an address here means the inventory pairing was lost");
    assert.doesNotMatch(name, /^inventory-\d+$/, "a positional label cannot be matched to a --limit flag");
  }
});
