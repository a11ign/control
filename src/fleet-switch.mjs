// @ts-check
/**
 * Where is each worker, and is it on? Asked of the network switch, which already knows (#3242).
 *
 *     fleet:status    prints one line per worker beside the neighbour-table lines
 *
 * ## Why the switch
 *
 * The neighbour table answers from the control plane's own point of view and only for a box that has
 * spoken. The Netgear GS728TP answers READ-ONLY SNMP v2c: the BRIDGE-MIB `dot1dTpFdbPort` maps each MAC to
 * the port it was learned on, and `ifOperStatus` / `ifHighSpeed` give each port's link and speed. A worker
 * sits on a known port (`switch_port:` in the inventory), so "where is it" is a lookup.
 *
 * ## What the output says, and what it must NOT say
 *
 * `on, MAC on port N` / `off, link up 100 Mb, no MAC` / `off, link down` / `unread`. **It never prints the
 * word "armed".** A link that stays up at 100 Mb in S5 may say only that the NIC has power: the box that was
 * NOT armed showed it too (the row's own trap). Whether a worker CAN be woken is #3227's `woken` outcome
 * and the OS-side read is #3230's `wake_armed`; this file reads a switch, not a NIC's wake setting.
 *
 * ## Three parts, so a test needs no socket
 *
 * 1. `switchStates`: PURE. Three readings plus the worker-to-port map in, one state per worker out.
 * 2. `readSwitch` over an injected `send(packet) => reply`: the SNMP walks. Tests hand it a fake switch.
 * 3. `udpSend` and `readSwitchLive`: the only code that opens a socket or reads a file.
 *
 * ## READ-ONLY IS A PROPERTY OF THE CODE, NOT OF THE COMMUNITY STRING
 *
 * `PDU` holds GET and GETNEXT and nothing else, and `buildRequest` THROWS on any other tag, so there is no
 * path from this module to a SET (0xA3). A community that happens to be read-only protects the switch today;
 * this protects it from the next person to paste a read-write one.
 *
 * ## No dependencies
 *
 * `packages/control` runs from a raw git checkout with no `node_modules` (`control-has-no-dependencies.test.ts`),
 * so the BER encoding below is the SNMP client. It is a small subset: v2c, GET/GETNEXT, integers and
 * OIDs, which is every byte this module sends or needs to read back.
 *
 * ## The switch's address and community stay out of git
 *
 * No default, like the control plane's own address (#83): `A11Y_SWITCH_HOST` / `A11Y_SWITCH_COMMUNITY`, else
 * the file `A11Y_SWITCH_FILE` (default `/etc/a11ign/switch`) holding `host=` and `community=` lines. The
 * community is never put in an error message or a printed line.
 */
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupPerLine, WORKER_GROUP } from "../../worker-fleet/src/fleet-env.mjs";
import { inventorySources, inventoryReadScript, parseInventoryReads, sshToControlPlane, macsByHost }
  from "./control-plane-fleet.mjs";

// --- the wire: a v2c GET / GETNEXT client, written out because this package has no dependencies --------

const SNMP_V2C = 1;
const SNMP_PORT = 161;
/** The ONLY request PDUs this module can build. There is deliberately no SET (0xA3) here, and no GETBULK. */
export const PDU = Object.freeze({ GET: 0xa0, GET_NEXT: 0xa1 });
const RESPONSE_PDU = 0xa2;

const TAG = Object.freeze({ INTEGER: 0x02, OCTETS: 0x04, NULL: 0x05, OID: 0x06, SEQUENCE: 0x30,
  COUNTER32: 0x41, GAUGE32: 0x42, TIME_TICKS: 0x43, COUNTER64: 0x46 });
const EXCEPTIONS = Object.freeze(/** @type {Record<number, string>} */ ({ 0x80: "noSuchObject",
  0x81: "noSuchInstance", 0x82: "endOfMibView" }));
/** @type {Set<number>} */
const UNSIGNED_TAGS = new Set([TAG.COUNTER32, TAG.GAUGE32, TAG.TIME_TICKS, TAG.COUNTER64]);

const LONG_FORM = 0x80;
const SEVEN_BITS = 0x7f;
const BYTE = 0x100;
const BASE_128 = 128;
const ARCS_PER_FIRST_BYTE = 40;
const MAX_LENGTH_BYTES = 4;
const MAC_ARCS = 6;
const HEX = 16;
const BITS_PER_BYTE = 8;

/** Bounds a walk so a switch that never reaches the end of the MIB cannot hold the command forever. */
const MAX_WALK_ROWS = 4096;

/** @param {number} length @returns {number[]} */
function lengthBytes(length) {
  if (length < LONG_FORM) return [length];
  /** @type {number[]} */
  const bytes = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / BYTE)) bytes.unshift(rest % BYTE);
  return [LONG_FORM | bytes.length, ...bytes];
}

/** @param {number} tag @param {Buffer} content @returns {Buffer} */
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag, ...lengthBytes(content.length)]), content]);
}

/**
 * A non-negative INTEGER, minimal two's complement: a leading zero byte keeps a high bit from reading as a sign.
 * @param {number} value
 * @returns {Buffer}
 */
function berInteger(value) {
  /** @type {number[]} */
  const bytes = [];
  for (let rest = value; ; rest = Math.floor(rest / BYTE)) {
    bytes.unshift(rest % BYTE);
    if (rest < BYTE) break;
  }
  if (bytes[0] >= LONG_FORM) bytes.unshift(0);
  return tlv(TAG.INTEGER, Buffer.from(bytes));
}

/** @param {number} arc @returns {number[]} base-128, high bit set on every byte but the last */
function arcBytes(arc) {
  const bytes = [arc & SEVEN_BITS];
  for (let rest = Math.floor(arc / BASE_128); rest > 0; rest = Math.floor(rest / BASE_128)) {
    bytes.unshift((rest & SEVEN_BITS) | LONG_FORM);
  }
  return bytes;
}

/** @param {string} dotted @returns {Buffer} */
function berOid(dotted) {
  const arcs = dotted.split(".").map(Number);
  if (arcs.length < 2 || arcs.some((arc) => !Number.isInteger(arc) || arc < 0)) throw new Error(`not an OID: ${dotted}`);
  const [first, second, ...rest] = arcs;
  const bytes = [first * ARCS_PER_FIRST_BYTE + second, ...rest.flatMap(arcBytes)];
  return tlv(TAG.OID, Buffer.from(bytes));
}

/**
 * One v2c request. THROWS on any PDU but GET / GETNEXT: that refusal is the whole of item 3's guarantee.
 *
 * @param {{ community: string, requestId: number, oid: string, pdu: number }} request
 * @returns {Buffer}
 */
export function buildRequest({ community, requestId, oid, pdu }) {
  if (pdu !== PDU.GET && pdu !== PDU.GET_NEXT) {
    throw new Error(`refusing to build PDU 0x${pdu.toString(HEX)}: this module only reads (GET, GETNEXT)`);
  }
  const binding = tlv(TAG.SEQUENCE, Buffer.concat([berOid(oid), tlv(TAG.NULL, Buffer.alloc(0))]));
  const body = Buffer.concat([berInteger(requestId), berInteger(0), berInteger(0), tlv(TAG.SEQUENCE, binding)]);
  return tlv(TAG.SEQUENCE, Buffer.concat([berInteger(SNMP_V2C),
    tlv(TAG.OCTETS, Buffer.from(community, "latin1")), tlv(pdu, body)]));
}

/** @typedef {{ tag: number, start: number, end: number }} Tlv */

/** @param {Buffer} buffer @param {number} at @returns {Tlv} */
function readTlv(buffer, at) {
  if (at + 1 >= buffer.length) throw new Error("truncated SNMP reply");
  const tag = buffer[at];
  let length = buffer[at + 1];
  let start = at + 2;
  if (length & LONG_FORM) {
    const count = length & SEVEN_BITS;
    if (count < 1 || count > MAX_LENGTH_BYTES) throw new Error("unsupported BER length in SNMP reply");
    length = buffer.readUIntBE(start, count);
    start += count;
  }
  if (start + length > buffer.length) throw new Error("truncated SNMP reply");
  return { tag, start, end: start + length };
}

/** @param {Buffer} buffer @param {Tlv} parent @returns {Tlv[]} */
function childrenOf(buffer, parent) {
  /** @type {Tlv[]} */
  const kids = [];
  for (let at = parent.start; at < parent.end;) {
    const kid = readTlv(buffer, at);
    kids.push(kid);
    at = kid.end;
  }
  return kids;
}

/** @param {Buffer} buffer @param {Tlv} item @returns {string} */
function decodeOid(buffer, item) {
  const bytes = [...buffer.subarray(item.start, item.end)];
  const [head, ...rest] = bytes;
  const firstArc = Math.min(Math.floor(head / ARCS_PER_FIRST_BYTE), 2);
  const arcs = [firstArc, head - firstArc * ARCS_PER_FIRST_BYTE];
  let arc = 0;
  for (const byte of rest) {
    arc = arc * BASE_128 + (byte & SEVEN_BITS);
    if (!(byte & LONG_FORM)) { arcs.push(arc); arc = 0; }
  }
  return arcs.join(".");
}

/** @param {Buffer} buffer @param {Tlv} item @returns {number} */
function decodeNumber(buffer, item) {
  let value = 0n;
  for (const byte of buffer.subarray(item.start, item.end)) value = value * BigInt(BYTE) + BigInt(byte);
  const bits = BigInt((item.end - item.start) * BITS_PER_BYTE);
  const negative = !UNSIGNED_TAGS.has(item.tag) && item.end > item.start && (buffer[item.start] & LONG_FORM) !== 0;
  return Number(negative ? value - (1n << bits) : value);
}

/** @typedef {{ oid: string, value: number | string | null, exception?: string }} VarBind */

/** @param {Buffer} buffer @param {Tlv} binding @returns {VarBind} */
function decodeBinding(buffer, binding) {
  const [oid, value] = childrenOf(buffer, binding);
  if (!oid || !value || oid.tag !== TAG.OID) throw new Error("malformed SNMP varbind");
  const name = decodeOid(buffer, oid);
  if (EXCEPTIONS[value.tag]) return { oid: name, value: null, exception: EXCEPTIONS[value.tag] };
  if (value.tag === TAG.INTEGER || UNSIGNED_TAGS.has(value.tag)) return { oid: name, value: decodeNumber(buffer, value) };
  if (value.tag === TAG.OCTETS) return { oid: name, value: buffer.subarray(value.start, value.end).toString("hex") };
  return { oid: name, value: null };
}

/**
 * @param {Buffer} reply
 * @returns {{ requestId: number, errorStatus: number, bindings: VarBind[] }}
 */
export function decodeResponse(reply) {
  const message = readTlv(reply, 0);
  const [, , pdu] = childrenOf(reply, message);
  if (message.tag !== TAG.SEQUENCE || !pdu || pdu.tag !== RESPONSE_PDU) throw new Error("not an SNMP response");
  const [requestId, errorStatus, , bindings] = childrenOf(reply, pdu);
  return {
    requestId: decodeNumber(reply, requestId),
    errorStatus: decodeNumber(reply, errorStatus),
    bindings: childrenOf(reply, bindings).map((binding) => decodeBinding(reply, binding)),
  };
}

/**
 * A client over an injected transport: `send(packet)` resolves with the reply packet or rejects.
 *
 * @param {{ send: (packet: Buffer) => Promise<Buffer>, community: string }} transport
 * @returns {{ get: (oid: string) => Promise<VarBind[]>, getNext: (oid: string) => Promise<VarBind[]> }}
 */
export function snmpClient({ send, community }) {
  let requestId = 0;
  /** @param {number} pdu */
  const ask = (pdu) => async (/** @type {string} */ oid) => {
    // Captured BEFORE the await: the port tables are walked in parallel on this one client, so the counter has
    // moved on by the time a reply returns, and comparing against it would refuse every reply but the last.
    requestId += 1;
    const mine = requestId;
    const reply = decodeResponse(await send(buildRequest({ community, requestId: mine, oid, pdu })));
    if (reply.requestId !== mine) throw new Error("the switch answered a different request");
    if (reply.errorStatus) throw new Error(`the switch answered SNMP error-status ${reply.errorStatus}`);
    return reply.bindings;
  };
  return { get: ask(PDU.GET), getNext: ask(PDU.GET_NEXT) };
}

/**
 * Every row under `base`, by GETNEXT. The walk ends at the first OID outside the subtree, or at
 * endOfMibView; one that never ends is an error, not a short table.
 *
 * @param {{ getNext: (oid: string) => Promise<VarBind[]> }} client
 * @param {string} base
 * @returns {Promise<VarBind[]>}
 */
export async function walk(client, base) {
  /** @type {VarBind[]} */
  const rows = [];
  let at = base;
  for (let step = 0; step < MAX_WALK_ROWS; step += 1) {
    const [binding] = await client.getNext(at);
    if (!binding || binding.exception || !binding.oid.startsWith(`${base}.`)) return rows;
    rows.push(binding);
    at = binding.oid;
  }
  throw new Error(`the walk of ${base} did not end within ${MAX_WALK_ROWS} rows`);
}

// --- the reads: three tables, and which MIB the switch keeps its forwarding table in -------------------

export const OID = Object.freeze({
  /** BRIDGE-MIB dot1dTpFdbPort.<mac as six arcs> */
  fdbBridge: "1.3.6.1.2.1.17.4.3.1.2",
  /** Q-BRIDGE-MIB dot1qTpFdbPort.<fdb id>.<mac as six arcs>: the per-VLAN form of the same table */
  fdbQBridge: "1.3.6.1.2.1.17.7.1.2.2.1.2",
  /** BRIDGE-MIB dot1dBasePortIfIndex.<bridge port>: a bridge port is NOT always an ifIndex */
  basePortIfIndex: "1.3.6.1.2.1.17.1.4.1.2",
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8",
  ifHighSpeed: "1.3.6.1.2.1.31.1.1.1.15",
});

const IF_OPER_UP = 1;
const IF_OPER_DOWN = 2;

/** @param {string} oid @returns {number} the last arc */
const lastArc = (oid) => Number(oid.slice(oid.lastIndexOf(".") + 1));

/** @param {string} oid the FDB row's OID @returns {string} the MAC in its last six arcs, aa:bb:... */
export function macOfFdbRow(oid) {
  return oid.split(".").slice(-MAC_ARCS).map((arc) => Number(arc).toString(HEX).padStart(2, "0")).join(":");
}

/**
 * @typedef {{ ok: true, table: string, macToPorts: Map<string, number[]>, linkByPort: Map<number, "up" | "down">,
 *             speedByPort: Map<number, number>, linkUnread: string | null, ifIndexIsPort: boolean | null }
 *         | { ok: false, reason: string }} Readings
 */

/** @param {VarBind[]} rows @returns {Map<string, number[]>} */
function macTable(rows) {
  /** @type {Map<string, number[]>} */
  const table = new Map();
  for (const { oid, value } of rows) {
    if (typeof value !== "number") continue;
    const mac = macOfFdbRow(oid);
    table.set(mac, [...(table.get(mac) ?? []), value]);
  }
  return table;
}

/**
 * The forwarding table from whichever MIB this switch keeps it in: BRIDGE-MIB first, Q-BRIDGE when that is
 * empty. Both empty is NOT "nobody is on the switch" (the control host alone makes that false) -- it is a
 * switch whose table this code cannot read, and says so.
 *
 * @param {{ getNext: (oid: string) => Promise<VarBind[]> }} client
 * @returns {Promise<{ table: string, rows: VarBind[] } | null>}
 */
async function forwardingTable(client) {
  const bridge = await walk(client, OID.fdbBridge);
  if (bridge.length) return { table: "BRIDGE-MIB dot1dTpFdbPort", rows: bridge };
  const qBridge = await walk(client, OID.fdbQBridge);
  return qBridge.length ? { table: "Q-BRIDGE-MIB dot1qTpFdbPort", rows: qBridge } : null;
}

/**
 * Port link, speed, and which ifIndex each bridge port is, keyed by BRIDGE port so the three share a key.
 * `ifIndexIsPort` records whether the two numberings agree on this model, READ rather than assumed (#3242 item 5).
 *
 * @param {{ getNext: (oid: string) => Promise<VarBind[]> }} client
 */
async function portTables(client) {
  const [base, status, speed] = await Promise.all([
    walk(client, OID.basePortIfIndex), walk(client, OID.ifOperStatus), walk(client, OID.ifHighSpeed)]);
  const statusByIf = new Map(status.map(({ oid, value }) => [lastArc(oid), value]));
  const speedByIf = new Map(speed.map(({ oid, value }) => [lastArc(oid), value]));
  /** @type {Map<number, "up" | "down">} */
  const linkByPort = new Map();
  /** @type {Map<number, number>} */
  const speedByPort = new Map();
  for (const { oid, value } of base) {
    const port = lastArc(oid);
    const state = statusByIf.get(Number(value));
    if (state === IF_OPER_UP) linkByPort.set(port, "up");
    if (state === IF_OPER_DOWN) linkByPort.set(port, "down");
    const mbps = speedByIf.get(Number(value));
    if (typeof mbps === "number") speedByPort.set(port, mbps);
  }
  const ifIndexIsPort = base.length ? base.every(({ oid, value }) => lastArc(oid) === value) : null;
  return { linkByPort, speedByPort, ifIndexIsPort };
}

/**
 * The three readings. A switch that does not answer the forwarding-table walk is `ok: false` and says why;
 * one that answers it but not the port tables is `ok: true` with `linkUnread`, so the MAC half still reports.
 *
 * @param {{ getNext: (oid: string) => Promise<VarBind[]> }} client
 * @returns {Promise<Readings>}
 */
export async function readSwitch(client) {
  let forwarding;
  try {
    forwarding = await forwardingTable(client);
  } catch (error) {
    return { ok: false, reason: `the switch did not answer (${/** @type {Error} */ (error).message})` };
  }
  if (!forwarding) {
    return { ok: false, reason: "the switch has no forwarding-table row in dot1dTpFdbPort or dot1qTpFdbPort" };
  }
  const macToPorts = macTable(forwarding.rows);
  try {
    return { ok: true, table: forwarding.table, macToPorts, ...(await portTables(client)), linkUnread: null };
  } catch (error) {
    return { ok: true, table: forwarding.table, macToPorts, linkByPort: new Map(), speedByPort: new Map(),
      ifIndexIsPort: null, linkUnread: /** @type {Error} */ (error).message };
  }
}

// --- the pure half: readings and a worker-to-port map in, one state per worker out ---------------------

/**
 * @typedef {{ kind: "on", port: number }
 *         | { kind: "on-elsewhere", port: number, seenOn: number[] }
 *         | { kind: "off-link-up", port: number, speedMbps: number | null }
 *         | { kind: "off-link-down", port: number }
 *         | { kind: "off-link-unread", port: number }
 *         | { kind: "unread", reason: string }
 *         | { kind: "unmapped", reason: string }} SwitchState
 */

/**
 * ONE STATE PER WORKER. Every input is injected; nothing here opens a socket or reads a file.
 *
 * The MAC decides ON: a box that is up has spoken and been learned. Absent from the table, the link says only
 * what the PORT is doing, and `off, link up` means the port has a carrier, which a box in S5 can still give.
 * A MAC learned on a port that is not the worker's own is `on-elsewhere`, named, because a box moved to
 * another port is what a map that is only a table cannot catch.
 *
 * @param {{ workers: { name: string, mac?: string | null, port?: number | null }[], readings: Readings }} input
 * @returns {{ name: string, state: SwitchState }[]}
 */
export function switchStates({ workers, readings }) {
  return workers.map(({ name, mac, port }) => ({ name, state: stateOfWorker({ mac, port }, readings) }));
}

/**
 * @param {{ mac?: string | null, port?: number | null }} worker
 * @param {Readings} readings
 * @returns {SwitchState}
 */
function stateOfWorker({ mac, port }, readings) {
  if (!readings.ok) return { kind: "unread", reason: readings.reason };
  if (port == null) return { kind: "unmapped", reason: "no switch_port in the inventory" };
  if (!mac) return { kind: "unmapped", reason: "no mac in the inventory" };
  const seenOn = readings.macToPorts.get(mac.toLowerCase()) ?? [];
  if (seenOn.includes(port)) return { kind: "on", port };
  if (seenOn.length) return { kind: "on-elsewhere", port, seenOn };
  const link = readings.linkByPort.get(port);
  if (link === "down") return { kind: "off-link-down", port };
  if (link === "up") return { kind: "off-link-up", port, speedMbps: readings.speedByPort.get(port) ?? null };
  return { kind: "off-link-unread", port };
}

/**
 * The words for one worker. NEVER the word "armed": see this file's header.
 *
 * @param {string} name
 * @param {SwitchState} state
 * @returns {string}
 */
export function switchLine(name, state) {
  switch (state.kind) {
    case "on": return `${name}: on, MAC on port ${state.port}`;
    case "on-elsewhere":
      return `${name}: on, but ${name}'s MAC is on port ${state.seenOn.join(", ")}, not its own port ${state.port}`
        + " (moved? fix switch_port in the inventory, or the cable)";
    case "off-link-up":
      return `${name}: off, link up${state.speedMbps ? ` ${state.speedMbps} Mb` : ""}, no MAC on port ${state.port}`;
    case "off-link-down": return `${name}: off, link down on port ${state.port}`;
    case "off-link-unread": return `${name}: no MAC on port ${state.port}, link state unread`;
    case "unmapped": return `${name}: not read (${state.reason})`;
    default: return `${name}: unread (${state.reason})`;
  }
}

/**
 * @typedef {{ lines: string[], states: { name: string, state: SwitchState }[], table: string | null,
 *             ifIndexIsPort: boolean | null }} SwitchReport
 */

/**
 * What `fleet:status` prints. Every worker unread for the same reason is ONE line, not sixteen, and the
 * line says the capture-port reading is untouched -- a switch that does not answer is a fact about the
 * switch, never a reason to hide what the workers said.
 *
 * @param {{ name: string, state: SwitchState }[]} states
 * @param {Readings} readings
 * @returns {SwitchReport}
 */
export function switchReport(states, readings) {
  const table = readings.ok ? readings.table : null;
  const ifIndexIsPort = readings.ok ? readings.ifIndexIsPort : null;
  const sameWord = (/** @type {SwitchState["kind"]} */ kind) => states.length > 0 && states.every(({ state }) => state.kind === kind);
  /** @type {string[]} */
  let lines;
  if (!readings.ok) lines = [`switch: unread (${readings.reason}); the worker readings below are unaffected`];
  else if (sameWord("unmapped")) lines = ["switch: not read (no worker declares switch_port in the inventory)"];
  else lines = states.map(({ name, state }) => switchLine(name, state));
  if (readings.ok && readings.linkUnread) lines.push(`switch: port link and speed unread (${readings.linkUnread})`);
  return { lines, states, table, ifIndexIsPort };
}

// --- the live half: the one place that reads a file, an inventory or a socket --------------------------

const DEFAULT_SWITCH_FILE = "/etc/a11ign/switch";
const SWITCH_TIMEOUT_MS = 2_000;
const SWITCH_ATTEMPTS = 2;
const ANSIBLE_DIR = resolve(import.meta.dirname, "../ansible");

/**
 * The switch's address and community: env first, then the file, else null. No default of either, because a
 * guessed community is a credential in a tracked file and a guessed address is a request to the wrong box.
 *
 * @param {{ env?: Record<string, string | undefined>, readFile?: (path: string) => string }} [deps]
 * @returns {{ host: string, community: string } | null}
 */
export function readSwitchConfig({ env = process.env, readFile = (path) => readFileSync(path, "utf8") } = {}) {
  /** @type {Record<string, string>} */
  const fromFile = {};
  try {
    for (const line of readFile(env.A11Y_SWITCH_FILE || DEFAULT_SWITCH_FILE).split(/\r?\n/)) {
      const pair = /^\s*(host|community)\s*=\s*(\S.*?)\s*$/.exec(line);
      if (pair) fromFile[pair[1]] = pair[2];
    }
  } catch {
    // An absent file is the ordinary state of every machine that has never been given the switch: the
    // caller turns a null result into "not configured", which is the record of it.
  }
  const host = env.A11Y_SWITCH_HOST || fromFile.host;
  const community = env.A11Y_SWITCH_COMMUNITY || fromFile.community;
  return host && community ? { host, community } : null;
}

/**
 * Each worker's `switch_port:`, keyed by `ansible_host`, from the inventory text. A NARROW READER in the shape
 * of `macsByHost` (control-plane-fleet.mjs): a host with no `switch_port:` is absent, which is a state.
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function switchPortsByHost(text) {
  /** @type {Map<string, number>} */
  const ports = new Map();
  const groups = groupPerLine(text);
  /** @type {{ host?: string, port?: number } | null} */
  let current = null;
  const flush = () => { if (current?.host && current.port) ports.set(current.host, current.port); };
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trimStart().startsWith("#") || groups[index] !== WORKER_GROUP) continue;
    if (/^\s{8}[A-Za-z0-9][\w-]*:\s*$/.test(line)) { flush(); current = {}; continue; }
    const host = line.match(/^\s*ansible_host\s*:\s*(\S+)\s*$/);
    if (host && current) current.host = host[1].replace(/^["']|["']$/g, "");
    const port = line.match(/^\s*switch_port\s*:\s*(\d+)\s*(?:#.*)?$/);
    if (port && current) current.port = Number(port[1]);
  }
  flush();
  return ports;
}

/**
 * One datagram out, one back, with a retry: UDP loses packets and a status command should not report a
 * switch unread over one. Only the switch's own address is believed.
 *
 * @param {string} host
 * @returns {(packet: Buffer) => Promise<Buffer>}
 */
export function udpSend(host) {
  return (packet) => new Promise((resolveReply, reject) => {
    const socket = dgram.createSocket("udp4");
    let attempts = 0;
    let timer = /** @type {NodeJS.Timeout | undefined} */ (undefined);
    const finish = (/** @type {() => void} */ settle) => { clearTimeout(timer); socket.close(); settle(); };
    const attempt = () => {
      attempts += 1;
      socket.send(packet, SNMP_PORT, host, (error) => { if (error) finish(() => reject(error)); });
      timer = setTimeout(() => (attempts < SWITCH_ATTEMPTS ? attempt()
        : finish(() => reject(new Error(`no reply in ${SWITCH_TIMEOUT_MS} ms x ${SWITCH_ATTEMPTS}`)))), SWITCH_TIMEOUT_MS);
    };
    socket.on("message", (reply, remote) => { if (remote.address === host) finish(() => resolveReply(reply)); });
    socket.on("error", (error) => finish(() => reject(error)));
    attempt();
  });
}

/** @param {string} url @returns {string} */
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * @param {{ name: string, url: string, mac?: string }[]} workers
 * @param {string[]} texts every inventory source, first to declare a value wins
 * @returns {{ name: string, mac: string | null, port: number | null }[]}
 */
function workersWithPorts(workers, texts) {
  return workers.map(({ name, url, mac }) => {
    const host = hostOf(url);
    const port = texts.map((text) => switchPortsByHost(text).get(host)).find(Boolean) ?? null;
    const declared = mac ?? texts.map((text) => macsByHost(text).get(host)).find(Boolean) ?? null;
    return { name: name.split(/\s+/)[0], mac: declared, port };
  });
}

/**
 * The control plane's own inventory texts, as every other reader takes them. The failure is worded here and
 * not passed through: an `execFileSync` error's message carries the whole ssh command line.
 *
 * @returns {string[]}
 */
function readInventoryTexts() {
  try {
    const sources = inventorySources(readFileSync(resolve(ANSIBLE_DIR, "ansible.cfg"), "utf8"));
    return parseInventoryReads(sshToControlPlane(inventoryReadScript(sources), { capture: true })).map(({ text }) => text);
  } catch (error) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr ?? "").trim().split("\n").pop();
    throw new Error(`the control plane's inventory could not be read${stderr ? ` (${stderr})` : ""}`, { cause: error });
  }
}

/**
 * The status command's one call. NEVER THROWS: a switch that cannot be reached, a missing configuration or
 * an unreadable inventory are each an "unread" report, because the box that is missing is what this command
 * is for and it must not be taken down by the one that asks about it.
 *
 * @param {{ name: string, url: string, mac?: string }[]} workers
 * @param {{ config?: { host: string, community: string } | null,
 *           readInventories?: () => string[],
 *           send?: (packet: Buffer) => Promise<Buffer> }} [deps] injectable so no test opens a socket
 * @returns {Promise<SwitchReport>}
 */
export async function readSwitchLive(workers, deps = {}) {
  const config = "config" in deps ? deps.config : readSwitchConfig();
  if (!config) {
    /** @type {Readings} */
    const unread = { ok: false, reason: "no switch configured: set A11Y_SWITCH_HOST and A11Y_SWITCH_COMMUNITY, or A11Y_SWITCH_FILE" };
    return switchReport(switchStates({ workers: workersWithPorts(workers, []), readings: unread }), unread);
  }
  try {
    const mapped = workersWithPorts(workers, (deps.readInventories ?? readInventoryTexts)());
    const readings = await readSwitch(snmpClient({ send: deps.send ?? udpSend(config.host), community: config.community }));
    return switchReport(switchStates({ workers: mapped, readings }), readings);
  } catch (error) {
    /** @type {Readings} */
    const unread = { ok: false, reason: `the switch could not be read: ${/** @type {Error} */ (error).message}` };
    return switchReport(switchStates({ workers: workersWithPorts(workers, []), readings: unread }), unread);
  }
}
