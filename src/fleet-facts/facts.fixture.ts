/**
 * WHAT THE FACTS PLAY PRINTS, for three real shapes of box (A11-283). Test support only; the service never imports it. The values are those a Lenovo ThinkCentre
 * Tiny M720q (type 10T8), an M710q (10MR) and an HP ProDesk 600 G4 DM report; where the ticket names no value (serials, BIOS, RAM, disks) the fixture's is made up.
 */
import type { BoxFacts } from "./types.ts";

type Raw = Record<string, unknown>;

const GB = 2 ** 30;

const base = (): Raw => ({
  bios: { SerialNumber: "PF1ABCDE", SMBIOSBIOSVersion: "M1UKT77A", ReleaseDate: "2024-03-14" },
  processors: [{ Name: "Intel(R) Core(TM) i5-8500T CPU @ 2.10GHz", NumberOfCores: 6, NumberOfLogicalProcessors: 6 }],
  memory: [
    { Capacity: 8 * GB, ConfiguredClockSpeed: 2666, Speed: 2666, PartNumber: "M471A1K43CB1-CTD" },
    { Capacity: 8 * GB, ConfiguredClockSpeed: 2666, Speed: 2666, PartNumber: "M471A1K43CB1-CTD" },
  ],
  disks: [{ FriendlyName: "SAMSUNG MZVLB256HBHQ-000L7", MediaType: "SSD", BusType: "NVMe", Size: 256_060_514_304 }],
  systemDrive: { DeviceID: "C:", FreeSpace: 180_000_000_000, Size: 255_000_000_000 },
  windows: { CurrentBuild: "26200", UBR: 6584, DisplayVersion: "25H2", EditionID: "Professional" },
  tpm: { state: "present", ready: true, specVersion: "2.0, 0, 1.38" },
  secureBoot: { state: "enabled" },
});

/** A Lenovo ThinkCentre Tiny M720q: `Model` is the machine type and part number, the model name is in the product's `Version`. */
export const m720q = (): Raw => ({
  ...base(),
  computerSystem: { Manufacturer: "LENOVO", Model: "10T8S0YP00", SystemSKUNumber: "LENOVO_MT_10T8_BU_Think_FM_ThinkCentre M720q", TotalPhysicalMemory: 16 * GB - 300_000_000 },
  product: { Version: "ThinkCentre M720q" },
});

/** The same make with an older CPU and one stick: type 10MR. */
export const m710q = (): Raw => ({
  ...base(),
  computerSystem: { Manufacturer: "LENOVO", Model: "10MRS0CD00", SystemSKUNumber: "LENOVO_MT_10MR_BU_Think_FM_ThinkCentre M710q", TotalPhysicalMemory: 8 * GB - 200_000_000 },
  product: { Version: "ThinkCentre M710q" },
  processors: [{ Name: "Intel(R) Core(TM) i5-7500T CPU @ 2.70GHz", NumberOfCores: 4, NumberOfLogicalProcessors: 4 }],
  memory: [{ Capacity: 8 * GB, ConfiguredClockSpeed: 2400, Speed: 2400, PartNumber: "HMA81GS6AFR8N-UH" }],
});

/** An HP ProDesk 600 G4 DM: `Model` is the name, and the product number is the SKU. */
export const prodesk = (): Raw => ({
  ...base(),
  computerSystem: { Manufacturer: "HP", Model: "HP ProDesk 600 G4 DM", SystemSKUNumber: "4KX37EA#ABD", TotalPhysicalMemory: 16 * GB - 250_000_000 },
  product: { Version: "" },
  bios: { SerialNumber: "CZC8123XYZ", SMBIOSBIOSVersion: "Q21 Ver. 02.19.00", ReleaseDate: "2023-11-02" },
  processors: [{ Name: "Intel(R) Core(TM) i3-8100T CPU @ 3.10GHz", NumberOfCores: 4, NumberOfLogicalProcessors: 4 }],
  disks: [{ FriendlyName: "KXG60ZNV256G TOSHIBA", MediaType: "SSD", BusType: "NVMe", Size: 256_060_514_304 }, { FriendlyName: "ST500LM034", MediaType: "HDD", BusType: "SATA", Size: 500_107_862_016 }],
});

/** The facts `parseFacts` makes of `m720q()`, written out. */
export const m720qFacts = (): BoxFacts => ({
  make: "LENOVO", model: "ThinkCentre M720q", machineType: "10T8", serial: "PF1ABCDE", bios: { version: "M1UKT77A", date: "2024-03-14" },
  cpu: { name: "Intel(R) Core(TM) i5-8500T CPU @ 2.10GHz", cores: 6, threads: 6 },
  ram: { totalBytes: 16 * GB - 300_000_000, modules: 2, speedMtps: 2666 },
  disks: [{ model: "SAMSUNG MZVLB256HBHQ-000L7", type: "SSD", bus: "NVMe", sizeBytes: 256_060_514_304 }],
  systemDrive: { freeBytes: 180_000_000_000, sizeBytes: 255_000_000_000 },
  windows: { build: "26200", ubr: 6584, displayVersion: "25H2", edition: "Professional" },
  tpm: { state: "present", ready: true, specVersion: "2.0, 0, 1.38" }, secureBoot: { state: "enabled" },
});
