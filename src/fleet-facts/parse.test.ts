/**
 * THE FACTS PARSER (A11-283): what the play printed for a box, as the facts the file keeps, and the refusals that name the field that is wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { m710q, m720q, m720qFacts, prodesk } from "./facts.fixture.ts";
import { parseFacts } from "./parse.ts";

const facts = (output: unknown) => {
  const parsed = parseFacts(output);
  assert.ok("facts" in parsed, `refused: ${"refusal" in parsed ? parsed.refusal : ""}`);
  return parsed.facts;
};
const refusal = (output: unknown): string => {
  const parsed = parseFacts(output);
  assert.ok("refusal" in parsed, "expected a refusal");
  return parsed.refusal;
};

test("a Lenovo M720q: the model is the product's Version, and the machine type the first four characters of Model", () => {
  assert.deepEqual(facts(m720q()), m720qFacts());
});

test("a Lenovo M710q has machine type 10MR", () => {
  const read = facts(m710q());
  assert.equal(read.machineType, "10MR");
  assert.equal(read.model, "ThinkCentre M710q");
  assert.equal(read.ram.modules, 1);
});

test("an HP ProDesk 600 G4 DM: the model is Model, the machine type is the SKU, and the CPU is the i3-8100T", () => {
  const read = facts(prodesk());
  assert.equal(read.make, "HP");
  assert.equal(read.model, "HP ProDesk 600 G4 DM");
  assert.equal(read.machineType, "4KX37EA#ABD");
  assert.match(read.cpu.name, /i3-8100T/);
  assert.deepEqual(read.disks.map((d) => [d.type, d.bus]), [["SSD", "NVMe"], ["HDD", "SATA"]]);
});

test("a one-element list that PowerShell wrote as the element itself reads as a list of one", () => {
  const raw = m710q();
  raw.memory = (raw.memory as unknown[])[0];
  raw.disks = (raw.disks as unknown[])[0];
  const read = facts(raw);
  assert.equal(read.ram.modules, 1);
  assert.equal(read.disks.length, 1);
});

test("the RAM speed is the configured one, else the rated one, and the slowest module's when they differ", () => {
  const raw = m720q();
  (raw.memory as Record<string, unknown>[])[0]!.ConfiguredClockSpeed = 0;
  (raw.memory as Record<string, unknown>[])[0]!.Speed = 2400;
  assert.equal(facts(raw).ram.speedMtps, 2400);
});

test("a TPM or Secure Boot read that threw is unknown with its message, and the box is still read", () => {
  const raw = m720q();
  raw.tpm = { state: "unknown", error: "Access is denied" };
  raw.secureBoot = { state: "unknown", error: "Cmdlet failed" };
  const read = facts(raw);
  assert.deepEqual(read.tpm, { state: "unknown", ready: null, specVersion: null, error: "Access is denied" });
  assert.deepEqual(read.secureBoot, { state: "unknown", error: "Cmdlet failed" });
});

test("Secure Boot on a legacy BIOS is unsupported, and an absent TPM is absent", () => {
  const raw = m720q();
  raw.secureBoot = { state: "unsupported" };
  raw.tpm = { state: "absent" };
  assert.equal(facts(raw).secureBoot.state, "unsupported");
  assert.equal(facts(raw).tpm.state, "absent");
});

test("a missing CPU is refused by name, and nothing is made up", () => {
  const raw = m720q();
  delete raw.processors;
  assert.equal(refusal(raw), "processors is empty");
});

test("a non-numeric capacity is refused by name", () => {
  const raw = m720q();
  (raw.memory as Record<string, unknown>[])[1]!.Capacity = "8 GB";
  assert.equal(refusal(raw), "memory[1].Capacity is missing or not a number");
});

test("a memory module with no speed at all is refused, not given one", () => {
  const raw = m720q();
  (raw.memory as Record<string, unknown>[])[0] = { Capacity: 8 * 2 ** 30, ConfiguredClockSpeed: 0, Speed: 0 };
  assert.equal(refusal(raw), "memory[0] has neither a ConfiguredClockSpeed nor a Speed");
});

test("a Lenovo with no Version has no model, and is refused", () => {
  const raw = m720q();
  raw.product = { Version: "" };
  assert.equal(refusal(raw), "product.Version is missing or not text");
});

test("an HP with no SKU has no machine type, and is refused", () => {
  const raw = prodesk();
  (raw.computerSystem as Record<string, unknown>).SystemSKUNumber = null;
  assert.equal(refusal(raw), "computerSystem.SystemSKUNumber is missing or not text");
});

test("an empty or non-object output is refused, naming what was wrong", () => {
  assert.equal(refusal(""), "the play printed nothing for this box");
  assert.equal(refusal(undefined), "the play printed nothing for this box");
  assert.equal(refusal([1]), "the play's output is not an object");
});

test("two sockets add their cores and threads", () => {
  const raw = m720q();
  raw.processors = [{ Name: "Xeon", NumberOfCores: 8, NumberOfLogicalProcessors: 16 }, { Name: "Xeon", NumberOfCores: 8, NumberOfLogicalProcessors: 16 }];
  assert.deepEqual([facts(raw).cpu.cores, facts(raw).cpu.threads], [16, 32]);
});
