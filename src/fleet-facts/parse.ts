import type { BoxFacts } from "./types.ts";

export type Parsed = { facts: BoxFacts } | { refusal: string };

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** A field that is missing or the wrong type refuses the whole read, naming it: a value is never made up. */
class Refusal extends Error {}

const text = (from: unknown, path: string): string => {
  if (typeof from !== "string" || !from.trim()) throw new Refusal(`${path} is missing or not text`);
  return from.trim();
};
const number = (from: unknown, path: string): number => {
  if (typeof from !== "number" || !Number.isFinite(from) || from < 0) throw new Refusal(`${path} is missing or not a number`);
  return from;
};
const object = (from: unknown, path: string): Obj => {
  if (!isObject(from)) throw new Refusal(`${path} is missing`);
  return from;
};
/** PowerShell writes a one-element list as the element itself, so a single object is a list of one. */
const list = (from: unknown, path: string): Obj[] => {
  const items = Array.isArray(from) ? from : from === undefined || from === null ? [] : [from];
  if (!items.length) throw new Refusal(`${path} is empty`);
  return items.map((item, i) => object(item, `${path}[${i}]`));
};
const optionalText = (from: unknown): string | null => typeof from === "string" && from.trim() ? from.trim() : null;

/** Lenovo's `Model` is the machine type followed by the part number (`10T8S0YP00`): the type is its first four characters. */
const LENOVO_TYPE_LENGTH = 4;

function identity(system: Obj, product: Obj): Pick<BoxFacts, "make" | "model" | "machineType"> {
  const make = text(system.Manufacturer, "computerSystem.Manufacturer");
  if (make.toUpperCase() === "LENOVO") {
    const type = text(system.Model, "computerSystem.Model");
    if (type.length < LENOVO_TYPE_LENGTH) throw new Refusal("computerSystem.Model is too short to hold a Lenovo machine type");
    return { make, model: text(product.Version, "product.Version"), machineType: type.slice(0, LENOVO_TYPE_LENGTH) };
  }
  return { make, model: text(system.Model, "computerSystem.Model"), machineType: text(system.SystemSKUNumber, "computerSystem.SystemSKUNumber") };
}

function memory(modules: Obj[], totalBytes: number): BoxFacts["ram"] {
  const speeds = modules.map((module, i) => {
    const configured = module.ConfiguredClockSpeed;
    const rated = module.Speed;
    const speed = typeof configured === "number" && configured > 0 ? configured : typeof rated === "number" && rated > 0 ? rated : null;
    if (speed === null) throw new Refusal(`memory[${i}] has neither a ConfiguredClockSpeed nor a Speed`);
    return speed;
  });
  modules.forEach((module, i) => number(module.Capacity, `memory[${i}].Capacity`));
  return { totalBytes, modules: modules.length, speedMtps: Math.min(...speeds) };
}

function tpm(from: unknown): BoxFacts["tpm"] {
  const read = object(from, "tpm");
  if (read.state === "unknown") return { state: "unknown", ready: null, specVersion: null, error: text(read.error, "tpm.error") };
  if (read.state !== "present" && read.state !== "absent") throw new Refusal("tpm.state is not present, absent or unknown");
  return { state: read.state, ready: typeof read.ready === "boolean" ? read.ready : null, specVersion: optionalText(read.specVersion) };
}

function secureBoot(from: unknown): BoxFacts["secureBoot"] {
  const read = object(from, "secureBoot");
  if (read.state === "unknown") return { state: "unknown", error: text(read.error, "secureBoot.error") };
  if (read.state !== "enabled" && read.state !== "disabled" && read.state !== "unsupported") throw new Refusal("secureBoot.state is not enabled, disabled, unsupported or unknown");
  return { state: read.state };
}

function build(output: Obj): BoxFacts {
  const system = object(output.computerSystem, "computerSystem");
  const bios = object(output.bios, "bios");
  const processors = list(output.processors, "processors");
  const drive = object(output.systemDrive, "systemDrive");
  const windows = object(output.windows, "windows");
  const ubr = number(windows.UBR, "windows.UBR");
  return {
    ...identity(system, object(output.product, "product")),
    serial: text(bios.SerialNumber, "bios.SerialNumber"),
    bios: { version: text(bios.SMBIOSBIOSVersion, "bios.SMBIOSBIOSVersion"), date: text(bios.ReleaseDate, "bios.ReleaseDate") },
    cpu: {
      name: text(processors[0]!.Name, "processors[0].Name"),
      cores: processors.reduce((sum, cpu, i) => sum + number(cpu.NumberOfCores, `processors[${i}].NumberOfCores`), 0),
      threads: processors.reduce((sum, cpu, i) => sum + number(cpu.NumberOfLogicalProcessors, `processors[${i}].NumberOfLogicalProcessors`), 0),
    },
    ram: memory(list(output.memory, "memory"), number(system.TotalPhysicalMemory, "computerSystem.TotalPhysicalMemory")),
    disks: list(output.disks, "disks").map((disk, i) => ({
      model: text(disk.FriendlyName, `disks[${i}].FriendlyName`), type: text(disk.MediaType, `disks[${i}].MediaType`),
      bus: text(disk.BusType, `disks[${i}].BusType`), sizeBytes: number(disk.Size, `disks[${i}].Size`) })),
    systemDrive: { freeBytes: number(drive.FreeSpace, "systemDrive.FreeSpace"), sizeBytes: number(drive.Size, "systemDrive.Size") },
    windows: { build: text(windows.CurrentBuild, "windows.CurrentBuild"), ubr, displayVersion: optionalText(windows.DisplayVersion), edition: optionalText(windows.EditionID) },
    tpm: tpm(output.tpm),
    secureBoot: secureBoot(output.secureBoot),
  };
}

/**
 * What the facts play printed for a box, as the facts it keeps, or the refusal that names the first field that is missing or of the wrong type (A11-283).
 * PURE. A Lenovo's model is `Win32_ComputerSystemProduct.Version` and its machine type the first four characters of `Win32_ComputerSystem.Model`; any other make
 * has `Model` and `SystemSKUNumber`. A RAM speed is the configured one, else the rated one, and the slowest module's when they differ.
 */
export function parseFacts(output: unknown): Parsed {
  if (output === undefined || output === null || output === "") return { refusal: "the play printed nothing for this box" };
  if (!isObject(output)) return { refusal: "the play's output is not an object" };
  try { return { facts: build(output) }; } catch (error) {
    if (error instanceof Refusal) return { refusal: error.message };
    throw error;
  }
}
