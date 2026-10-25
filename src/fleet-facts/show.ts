import type { BoxFacts, FactsEntry, FactsFile } from "./types.ts";

/** The columns of `fleet facts show`, in order. */
export const COLUMNS = ["box", "make / model (type)", "serial", "BIOS", "CPU", "RAM", "disks", "free on system drive", "Windows", "TPM", "Secure Boot", "read at"] as const;

const NONE = "-";

/** Disks are sold in decimal gigabytes (a "256 GB" SSD is 256 060 514 304 bytes); RAM in binary ones (16 GB is 16 GiB less what the firmware keeps). */
const decimalGb = (bytes: number): string => `${Math.round(bytes / 1e9)}`;
const binaryGb = (bytes: number): string => `${Math.round(bytes / 2 ** 30)}`;

const modelOf = ({ make, model, machineType }: BoxFacts): string =>
  `${model.toUpperCase().startsWith(make.toUpperCase()) ? "" : `${make} `}${model} (${machineType})`;

const diskType = ({ bus, type }: BoxFacts["disks"][number]): string => type === "Unspecified" ? bus : `${bus} ${type}`;

const tpmOf = ({ tpm }: BoxFacts): string =>
  tpm.state === "unknown" ? `unknown: ${tpm.error}` : tpm.state === "absent" ? "absent" : `present, ${tpm.ready === null ? "readiness unknown" : tpm.ready ? "ready" : "not ready"}, spec ${tpm.specVersion ?? "unknown"}`;

/** When the box was last read, or why its facts are not current. */
export function readAtOf(entry: FactsEntry | undefined): string {
  if (!entry) return "never read";
  const attempt = `last attempt ${entry.lastAttemptAt}: ${entry.lastError ?? "no reason was recorded"}`;
  if (entry.facts === null || entry.readAt === null) return `never read; ${attempt}`;
  return entry.stale ? `STALE: last read ${entry.readAt}; ${attempt}` : entry.readAt;
}

function factsCells(facts: BoxFacts): string[] {
  return [
    modelOf(facts), facts.serial, `${facts.bios.version} ${facts.bios.date}`,
    `${facts.cpu.name}, ${facts.cpu.cores} c / ${facts.cpu.threads} t`,
    `${binaryGb(facts.ram.totalBytes)} GB, ${facts.ram.modules} × ${facts.ram.speedMtps} MT/s`,
    facts.disks.map((disk) => `${disk.model} ${diskType(disk)} ${decimalGb(disk.sizeBytes)} GB`).join("; "),
    `${decimalGb(facts.systemDrive.freeBytes)} / ${decimalGb(facts.systemDrive.sizeBytes)} GB`,
    `${facts.windows.build}.${facts.windows.ubr}${facts.windows.displayVersion ? ` (${facts.windows.displayVersion})` : ""}`,
    tpmOf(facts),
    facts.secureBoot.state === "unknown" ? `unknown: ${facts.secureBoot.error}` : facts.secureBoot.state,
  ];
}

/**
 * The rows of the table: one per box, the inventory's boxes in its order and then any box only the file knows, sorted. A stale box shows its last facts; a box
 * never read shows none. `only` narrows the rows to those boxes, in the same order. PURE.
 */
export function factsRows(file: FactsFile, inventory: string[], only: string[] | null = null): string[][] {
  const extra = Object.keys(file.boxes).filter((name) => !inventory.includes(name)).sort();
  const boxes = [...inventory, ...extra].filter((name) => only === null || only.includes(name));
  return boxes.map((name) => {
    const entry = file.boxes[name];
    return [name, ...(entry?.facts ? factsCells(entry.facts) : Array(COLUMNS.length - 2).fill(NONE) as string[]), readAtOf(entry)];
  });
}

/** The table as text: a header, then one line per row, each column as wide as its widest cell. */
export function renderTable(rows: string[][]): string[] {
  const all = [[...COLUMNS] as string[], ...rows];
  const widths = COLUMNS.map((_, column) => Math.max(...all.map((row) => row[column]!.length)));
  return all.map((row) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  "));
}
