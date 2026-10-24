// @ts-check
/**
 * THE VERSIONS THE FLEET RUNS, AND THE ONE READER OF THEM (A11-205).
 *
 * `deploy-pins.json` says what control deploys. It also says what every box runs: the Windows release and build (and the cumulative update
 * that produces it), Edge, NVDA and Node. They are written there and nowhere else. The worker role derives its Edge and Node installs from
 * the file (`ansible/roles/worker/defaults/main.yml`), and `fleet:status` compares every box with it. A box that differs is OFF THE MANIFEST,
 * whichever other box it agrees with: a fleet that drifted together reads as clean when boxes are only compared with each other.
 *
 * The worker CODE a box serves is not written down. It is the hash of the pinned `nvda-worker` release (`layerCodeVersion`), the same hasher
 * `deploy.yml` reads back, so the manifest holds the release and not a hash that could disagree with it.
 *
 * Nothing here reads a box or moves one. Imports `node:` modules and control's own layer resolver only, so `control-has-no-dependencies.test.ts`
 * holds. Like `parseDeployPins`, a pin that cannot be read is a refusal naming the first thing wrong with it, never a default.
 */
import { readFileSync } from "node:fs";
import { layerCodeVersion } from "./layer-checkouts.ts";
import { DEPLOY_PINS_PATH } from "./layer-pins.ts";

export type FleetPins = {
  windows: { release: string; build: string; kb: string; };
  edge: { version: string; msiUrl: string; msiSha256: string; };
  nvda: { version: string; };
  node: { version: string; sha256: { x64: string; arm64: string; }; };
};

/** The four things `fleet:status` reads off every box, named as its lines name them, with what the manifest wants of each. */
export const DRIFT_FIELDS = ["Windows", "Edge", "NVDA", "Worker code"] as const;
export type DriftField = (typeof DRIFT_FIELDS)[number];
export type ExpectedFleet = Record<DriftField, string>;

const RELEASE = /^\d{2}H\d$/;
const WINDOWS_BUILD = /^\d+\.\d+$/;
const KB = /^KB\d{6,8}$/;
const EDGE_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const NVDA_VERSION = /^\d{4}\.\d+(\.\d+)?$/;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HTTPS_URL = /^https:\/\/[^\s"]+$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first refusal over one section of the manifest (`where` is its path, such as `node.sha256`): it must be an object, and each key must match its pattern. */
function sectionRefusal(section: unknown, where: string, keys: Record<string, [RegExp, string]>): string | null {
  if (!isObject(section)) return `deploy-pins.json declares no \`${where}\`: the fleet's ${where} version is written there and nowhere else`;
  for (const [key, [pattern, shape]] of Object.entries(keys)) {
    const value = section[key];
    if (typeof value !== "string" || !pattern.test(value)) return `deploy-pins.json ${where}.${key} is ${JSON.stringify(value)}, not ${shape}`;
  }
  return null;
}

/** The manifest as text, or the refusal naming the first thing wrong with it. */
export function parseFleetPins(text: string): { pins: FleetPins; } | { refusal: string; } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { refusal: `deploy-pins.json is not JSON (${cause instanceof Error ? cause.message : String(cause)})` };
  }
  if (!isObject(parsed)) return { refusal: "deploy-pins.json is not an object" };
  const { windows, edge, nvda, node } = parsed;
  const refusal = sectionRefusal(windows, "windows", {
      release: [RELEASE, "a Windows release such as <yy>H<n>"],
      build: [WINDOWS_BUILD, "a <CurrentBuild>.<UBR> build number"],
      kb: [KB, "a cumulative update KB (KB followed by digits): without it an upgrade lands on the newest update of the day"],
    })
    ?? sectionRefusal(edge, "edge", {
      version: [EDGE_VERSION, "an exact four-part Edge version"],
      msiUrl: [HTTPS_URL, "an https URL"],
      msiSha256: [SHA256, "a sha256 in lowercase hex: the pin is a fact about the bytes, not about a hostname"],
    })
    ?? sectionRefusal(nvda, "nvda", { version: [NVDA_VERSION, "a <year>.<n> or <year>.<n>.<n> NVDA version"] })
    ?? sectionRefusal(node, "node", { version: [NODE_VERSION, "a v<semver> Node version"] })
    ?? sectionRefusal((node as Record<string, unknown>).sha256, "node.sha256", {
      x64: [SHA256, "a sha256 in lowercase hex"],
      arm64: [SHA256, "a sha256 in lowercase hex"],
    });
  if (refusal !== null) return { refusal };
  const w = windows as FleetPins["windows"], e = edge as FleetPins["edge"], n = node as FleetPins["node"];
  return { pins: {
    windows: { release: w.release, build: w.build, kb: w.kb },
    edge: { version: e.version, msiUrl: e.msiUrl, msiSha256: e.msiSha256 },
    nvda: { version: (nvda as FleetPins["nvda"]).version },
    node: { version: n.version, sha256: { x64: n.sha256.x64, arm64: n.sha256.arm64 } },
  } };
}

/** `parseFleetPins` over the file, throwing the refusal: nothing that compares a box with the manifest can go on without it. */
export function readFleetPins(path: string = DEPLOY_PINS_PATH): FleetPins {
  const read = parseFleetPins(readFileSync(path, "utf8"));
  if ("refusal" in read) throw new Error(read.refusal);
  return read.pins;
}

/**
 * What `fleet:status` wants of every box. The worker code is derived from the pinned `nvda-worker` release, not written down, and a hash that
 * cannot be derived THROWS: a drift check with no expected code would pass every box.
 */
export async function expectedFleetOf(pins: FleetPins, codeOf: (layer: string) => Promise<string> = layerCodeVersion): Promise<ExpectedFleet> {
  return { Windows: pins.windows.build, Edge: pins.edge.version, NVDA: pins.nvda.version, "Worker code": await codeOf("nvda-worker") };
}

let real: Promise<ExpectedFleet> | undefined;

/** The real manifest's expectation, read once per process: every `fleetStatus` in a test run would otherwise hash the worker's sources again. */
export function readExpectedFleet(): Promise<ExpectedFleet> {
  return (real ??= expectedFleetOf(readFleetPins()));
}
