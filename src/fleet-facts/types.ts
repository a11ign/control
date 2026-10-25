/** What a facts read keeps of one box (A11-283): the hardware and firmware, read from CIM and the registry, never from the worker's HTTP. */
export type BoxFacts = {
  make: string;
  model: string;
  machineType: string;
  serial: string;
  bios: { version: string; date: string };
  cpu: { name: string; cores: number; threads: number };
  ram: { totalBytes: number; modules: number; speedMtps: number };
  disks: { model: string; type: string; bus: string; sizeBytes: number }[];
  systemDrive: { freeBytes: number; sizeBytes: number };
  windows: { build: string; ubr: number; displayVersion: string | null; edition: string | null };
  /** A read that threw is `unknown` with the message, never a failed read of the box. */
  tpm: { state: "present" | "absent" | "unknown"; ready: boolean | null; specVersion: string | null; error?: string };
  secureBoot: { state: "enabled" | "disabled" | "unsupported" | "unknown"; error?: string };
};

/** One box's entry in `fleet-facts.json`. `facts` and `readAt` are the last good read, kept through a failed one, which sets `stale`. */
export type FactsEntry = {
  readAt: string | null;
  stale: boolean;
  lastAttemptAt: string;
  lastJob: string;
  lastError: string | null;
  facts: BoxFacts | null;
};

export type FactsFile = { version: 1; boxes: Record<string, FactsEntry> };

/** The record `results/<box>.facts.json` keeps: shaped like a capture's (`worker`, `status`), with the facts or the error. */
export type FactsRecord = { readAt: string; worker: string; status: "done" | "failed"; changed: number | null; facts?: BoxFacts; error?: string };
