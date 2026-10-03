// `fleet-switch.mjs` answers "where is each worker, and is it on" from a switch, so the tests are about the
// states it must keep APART (on at its port, on at someone else's, off with a carrier, off without one, and
// "could not read"), and about the one thing it must never do: send anything but a read.
//
// OFFLINE. The SNMP transport is a function the test hands in, so no test here opens a socket. The fake
// switch below ENCODES its replies with its own BER writer, separate from the module's, so a bug in the
// module's reader is not hidden by the same bug in the thing that feeds it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { PDU, buildRequest, decodeResponse, snmpClient, walk, readSwitch, switchStates, switchLine, switchReport,
  readSwitchConfig, switchPortsByHost, readSwitchLive, macOfFdbRow, OID } from "./fleet-switch.mjs";

// --- a fake switch: a table of OID -> value, answering GET and GETNEXT, recording every packet ----------

const tlv = (tag: number, body: Buffer) => {
  const length = body.length < 0x80 ? [body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const int = (n: number) => {
  const bytes: number[] = [];
  let rest = n;
  do { bytes.unshift(rest & 0xff); rest = Math.floor(rest / 256); } while (rest > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
};
const oidBytes = (dotted: string) => {
  const arcs = dotted.split(".").map(Number);
  const out = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const group = [arc & 0x7f];
    for (let rest = arc >> 7; rest > 0; rest >>= 7) group.unshift((rest & 0x7f) | 0x80);
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
};
const parts = (buffer: Buffer) => {
  const out: { tag: number; body: Buffer }[] = [];
  for (let at = 0; at < buffer.length;) {
    let length = buffer[at + 1];
    let head = 2;
    if (length & 0x80) { const n = length & 0x7f; length = buffer.readUIntBE(at + 2, n); head = 2 + n; }
    out.push({ tag: buffer[at], body: buffer.subarray(at + head, at + head + length) });
    at += head + length;
  }
  return out;
};
const compare = (a: string, b: string) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
};
const oidText = (body: Buffer) => {
  const arcs = [Math.min(Math.floor(body[0] / 40), 2), body[0] % 40];
  arcs[1] = body[0] - arcs[0] * 40;
  let arc = 0;
  for (const byte of body.subarray(1)) { arc = arc * 128 + (byte & 0x7f); if (!(byte & 0x80)) { arcs.push(arc); arc = 0; } }
  return arcs.join(".");
};

type Mib = Record<string, number>;
const MAC_A = "aa:bb:cc:00:00:04";
const MAC_B = "aa:bb:cc:00:00:05";
const arcsOf = (mac: string) => mac.split(":").map((hex) => parseInt(hex, 16)).join(".");

/** What the switch holds: forwarding table (BRIDGE-MIB), link per ifIndex, speed per ifIndex, bridge port -> ifIndex. */
function mib({ fdb = {}, qfdb = {}, status = {}, speed = {}, base = {} }: {
  fdb?: Record<string, number>; qfdb?: Record<string, number>; status?: Record<number, number>;
  speed?: Record<number, number>; base?: Record<number, number> }): Mib {
  const out: Mib = {};
  for (const [mac, port] of Object.entries(fdb)) out[`${OID.fdbBridge}.${arcsOf(mac)}`] = port;
  for (const [mac, port] of Object.entries(qfdb)) out[`${OID.fdbQBridge}.1.${arcsOf(mac)}`] = port;
  for (const [i, v] of Object.entries(status)) out[`${OID.ifOperStatus}.${i}`] = v;
  for (const [i, v] of Object.entries(speed)) out[`${OID.ifHighSpeed}.${i}`] = v;
  for (const [i, v] of Object.entries(base)) out[`${OID.basePortIfIndex}.${i}`] = v;
  return out;
}

function fakeSwitch(table: Mib, { code = 0x02 }: { code?: number } = {}) {
  const packets: Buffer[] = [];
  const send = async (packet: Buffer) => {
    packets.push(packet);
    const [version, community, pdu] = parts(parts(packet)[0].body);
    const [id, , , list] = parts(pdu.body);
    const asked = oidText(parts(parts(list.body)[0].body)[0].body);
    const sorted = Object.keys(table).sort(compare);
    const hit = pdu.tag === PDU.GET ? sorted.find((o) => o === asked) : sorted.find((o) => compare(o, asked) > 0);
    const value = hit === undefined ? tlv(0x82, Buffer.alloc(0)) : tlv(code, (int(table[hit]).subarray(2)));
    const binding = tlv(0x30, Buffer.concat([oidBytes(hit ?? asked), value]));
    const body = Buffer.concat([tlv(0x02, id.body), int(0), int(0), tlv(0x30, binding)]);
    return tlv(0x30, Buffer.concat([tlv(0x02, version.body), tlv(0x04, community.body), tlv(0xa2, body)]));
  };
  return { send, packets };
}

const readOf = async (table: Mib) => readSwitch(snmpClient({ send: fakeSwitch(table).send, community: "x" }));

// A switch with w4 (port 17) on, w5 (port 18) off with carrier at 100 Mb, w6 (port 14) down.
const FLEET = mib({
  fdb: { [MAC_A]: 17, "aa:bb:cc:00:00:09": 13 },
  base: { 13: 13, 14: 14, 17: 17, 18: 18 },
  status: { 13: 1, 14: 2, 17: 1, 18: 1 },
  speed: { 13: 1000, 14: 0, 17: 1000, 18: 100 },
});

// --- the wire -----------------------------------------------------------------------------------------

test("a GETNEXT is the bytes every SNMP tool sends for the same question", () => {
  // The canonical `snmpgetnext -v2c -c public host 1.3.6.1.2.1.1.1.0` datagram, worked out by hand.
  const packet = buildRequest({ community: "public", requestId: 1, oid: "1.3.6.1.2.1.1.1.0", pdu: PDU.GET_NEXT });
  assert.equal(packet.toString("hex"), "302602010104067075626c6963a119020101020100020100300e300c06082b060102010101000500");
  assert.equal(buildRequest({ community: "public", requestId: 1, oid: "1.3.6.1.2.1.1.1.0", pdu: PDU.GET })
    .toString("hex"), packet.toString("hex").replace("a119", "a019"), "GET differs from GETNEXT in the one tag");
});

test("READ-ONLY: of all 256 PDU tags, buildRequest builds exactly two, and SET is not one of them", () => {
  const built = [];
  for (let pdu = 0; pdu < 256; pdu += 1) {
    try { buildRequest({ community: "c", requestId: 1, oid: "1.3.6.1.2.1.1.1.0", pdu }); built.push(pdu); } catch { /* refused */ }
  }
  assert.deepEqual(built, [0xa0, 0xa1], "GET and GETNEXT only");
  assert.throws(() => buildRequest({ community: "c", requestId: 1, oid: "1.3.6.1.2.1.1.1.0", pdu: 0xa3 }), /only reads/);
  assert.deepEqual(Object.keys(PDU), ["GET", "GET_NEXT"]);
});

test("READ-ONLY: every packet a whole read sends is a GET or a GETNEXT, and the read sends many", async () => {
  const fake = fakeSwitch(FLEET);
  const readings = await readSwitch(snmpClient({ send: fake.send, community: "x" }));
  assert.equal(readings.ok, true);
  const tags = fake.packets.map((packet) => parts(parts(packet)[0].body)[2].tag);
  assert.ok(tags.length > 5, `a control for the assertion below: ${tags.length} packets were sent`);
  assert.ok(tags.every((tag) => tag === PDU.GET || tag === PDU.GET_NEXT), `PDU tags sent: ${[...new Set(tags)]}`);
});

test("a reply is decoded: counters, gauges, long-form lengths and a negative integer", () => {
  const reply = (code: number, value: Buffer) => tlv(0x30, Buffer.concat([int(1), tlv(0x04, Buffer.from("x")),
    tlv(0xa2, Buffer.concat([int(7), int(0), int(0), tlv(0x30, tlv(0x30, Buffer.concat([oidBytes("1.3.6.1.2.1.31.1.1.1.15.300"), tlv(code, value)])))]))]));
  assert.deepEqual(decodeResponse(reply(0x42, Buffer.from([0x03, 0xe8]))).bindings, [{ oid: "1.3.6.1.2.1.31.1.1.1.15.300", value: 1000 }]);
  assert.equal(decodeResponse(reply(0x02, Buffer.from([0xff]))).bindings[0].value, -1, "INTEGER is signed");
  assert.equal(decodeResponse(reply(0x41, Buffer.from([0xff]))).bindings[0].value, 255, "Counter32 is not");
  assert.equal(decodeResponse(reply(0x81, Buffer.alloc(0))).bindings[0].exception, "noSuchInstance");
  assert.equal(decodeResponse(reply(0x42, Buffer.from([0x03, 0xe8]))).requestId, 7);
});

test("a reply that is not a response, or is cut short, is an error and never a table", () => {
  assert.throws(() => decodeResponse(buildRequest({ community: "c", requestId: 1, oid: "1.3.6.1.2.1.1.1.0", pdu: PDU.GET })), /not an SNMP response/);
  assert.throws(() => decodeResponse(Buffer.from([0x30, 0x20, 0x02])), /truncated/);
});

test("a walk stops at the edge of its subtree, and a switch that never ends is refused", async () => {
  const client = snmpClient({ send: fakeSwitch(FLEET).send, community: "x" });
  const rows = await walk(client, OID.ifOperStatus);
  assert.deepEqual(rows.map(({ oid }) => oid.split(".").pop()), ["13", "14", "17", "18"], "only the ifOperStatus rows, in order");
  const endless = { getNext: async () => [{ oid: `${OID.ifOperStatus}.1`, value: 1 }] };
  await assert.rejects(walk(endless, OID.ifOperStatus), /did not end/);
});

const response = (id: number, status: number, bindings: Buffer) => tlv(0x30, Buffer.concat([int(1), tlv(0x04, Buffer.from("x")),
  tlv(0xa2, Buffer.concat([int(id), int(status), int(status ? 1 : 0), tlv(0x30, bindings)]))]));

test("a reply to a different request, or an SNMP error-status, is refused", async () => {
  const wrongId = snmpClient({ community: "x", send: async () => response(999, 0, Buffer.alloc(0)) });
  await assert.rejects(wrongId.getNext(OID.ifOperStatus), /different request/);
  const erroring = snmpClient({ community: "x", send: async () => response(1, 5, Buffer.alloc(0)) });
  await assert.rejects(erroring.getNext(OID.ifOperStatus), /error-status 5/);
});

// --- which table the switch keeps, and whether ifIndex is the port (item 5, read and not assumed) -------

test("the forwarding table is read from BRIDGE-MIB, then from Q-BRIDGE when BRIDGE-MIB is empty, and says which", async () => {
  const bridge = await readOf(FLEET);
  const qbridge = await readOf(mib({ qfdb: { [MAC_A]: 17 }, base: { 17: 17 }, status: { 17: 1 }, speed: { 17: 1000 } }));
  assert.ok(bridge.ok && qbridge.ok);
  if (bridge.ok && qbridge.ok) {
    assert.equal(bridge.table, "BRIDGE-MIB dot1dTpFdbPort");
    assert.equal(qbridge.table, "Q-BRIDGE-MIB dot1qTpFdbPort");
    assert.deepEqual(qbridge.macToPorts.get(MAC_A), [17], "the FDB id before the MAC is skipped, the MAC is the last six arcs");
  }
});

test("ifIndex equal to the bridge port is read from dot1dBasePortIfIndex, and a model where it is not says so", async () => {
  const same = await readOf(FLEET);
  const shifted = await readOf(mib({ fdb: { [MAC_A]: 17 }, base: { 17: 1017 }, status: { 1017: 1 }, speed: { 1017: 100 } }));
  assert.ok(same.ok && shifted.ok);
  if (same.ok && shifted.ok) {
    assert.equal(same.ifIndexIsPort, true);
    assert.equal(shifted.ifIndexIsPort, false);
    assert.equal(shifted.linkByPort.get(17), "up", "link is read through the ifIndex the base table names, not assumed equal");
    assert.equal(shifted.speedByPort.get(17), 100);
  }
});

test("a switch that does not answer, or has no forwarding table, is unread with its reason, never an empty table", async () => {
  const silent = await readSwitch(snmpClient({ send: async () => { throw new Error("no reply in 2000 ms x 2"); }, community: "x" }));
  assert.deepEqual(silent, { ok: false, reason: "the switch did not answer (no reply in 2000 ms x 2)" });
  const emptyTables = await readOf(mib({ status: { 1: 1 } }));
  assert.equal(emptyTables.ok, false);
  assert.match(emptyTables.ok ? "" : emptyTables.reason, /no forwarding-table row/);
});

const askedOid = (packet: Buffer) => oidText(parts(parts(parts(parts(parts(packet)[0].body)[2].body)[3].body)[0].body)[0].body);

test("a switch that gives the MAC table but loses the port tables still reports the MACs", async () => {
  const base = fakeSwitch(FLEET).send;
  const flaky = async (packet: Buffer) => {
    if (!askedOid(packet).startsWith(OID.fdbBridge)) throw new Error("timed out");
    return base(packet);
  };
  const readings = await readSwitch(snmpClient({ send: flaky, community: "x" }));
  assert.ok(readings.ok);
  if (readings.ok) {
    assert.equal(readings.macToPorts.get(MAC_A)?.[0], 17);
    assert.match(readings.linkUnread ?? "", /timed out/);
    assert.equal(readings.linkByPort.size, 0);
  }
});

test("a MAC is its last six arcs", () => {
  assert.equal(macOfFdbRow(`${OID.fdbBridge}.170.187.204.0.0.4`), MAC_A);
});

// --- the pure function: each state is DIFFERENT, before the function is judged on any ------------------

const workers = {
  onOwn: { name: "w4", mac: MAC_A, port: 17 },
  onOther: { name: "w4", mac: MAC_A, port: 9 },
  offUp: { name: "w5", mac: MAC_B, port: 18 },
  offDown: { name: "w6", mac: MAC_B, port: 14 },
};

async function stateFor(worker: { name: string; mac?: string | null; port?: number | null }, table: Mib = FLEET) {
  return switchStates({ workers: [worker], readings: await readOf(table) })[0].state;
}

test("POSITIVE CONTROL: on its own port, on another's, off with a carrier, off without one and unread are five different states", async () => {
  const states = [
    await stateFor(workers.onOwn),
    await stateFor(workers.onOther),
    await stateFor(workers.offUp),
    await stateFor(workers.offDown),
    switchStates({ workers: [workers.onOwn], readings: { ok: false, reason: "no answer" } })[0].state,
  ];
  assert.deepEqual(states.map((state) => state.kind), ["on", "on-elsewhere", "off-link-up", "off-link-down", "unread"]);
  assert.equal(new Set(states.map((state) => JSON.stringify(state))).size, 5);
  assert.deepEqual(states[0], { kind: "on", port: 17 });
  assert.deepEqual(states[1], { kind: "on-elsewhere", port: 9, seenOn: [17] });
  assert.deepEqual(states[2], { kind: "off-link-up", port: 18, speedMbps: 100 });
});

test("a worker with no declared port or MAC is not read, and a port with no link row says its link is unread", async () => {
  assert.deepEqual(await stateFor({ name: "w9", mac: MAC_A }), { kind: "unmapped", reason: "no switch_port in the inventory" });
  assert.deepEqual(await stateFor({ name: "w9", port: 3 }), { kind: "unmapped", reason: "no mac in the inventory" });
  assert.deepEqual(await stateFor({ name: "w9", mac: MAC_B, port: 21 }), { kind: "off-link-unread", port: 21 });
});

test("a MAC is matched whatever the case the inventory wrote it in", async () => {
  assert.equal((await stateFor({ name: "w4", mac: MAC_A.toUpperCase(), port: 17 })).kind, "on");
});

test("MUTATION SHAPE: a function that ignored the MAC table would call w4 off, and this is the case that goes red", async () => {
  const readings = await readOf(FLEET);
  assert.ok(readings.ok);
  const blind = readings.ok ? { ...readings, macToPorts: new Map<string, number[]>() } : readings;
  assert.equal(switchStates({ workers: [workers.onOwn], readings })[0].state.kind, "on");
  assert.equal(switchStates({ workers: [workers.onOwn], readings: blind })[0].state.kind, "off-link-up",
    "with the table emptied the same worker reads off: the on case depends on the MAC table");
});

// --- the words ----------------------------------------------------------------------------------------

const everyState = async () => [
  ...[workers.onOwn, workers.onOther, workers.offUp, workers.offDown].map((w) => stateFor(w)),
  stateFor({ name: "w9" }), stateFor({ name: "w9", mac: MAC_B, port: 21 }),
  Promise.resolve({ kind: "unread" as const, reason: "no answer" }),
];

test("each state has its own line, and a moved box is named with both ports", async () => {
  const lines = (await Promise.all(await everyState())).map((state, i) => switchLine(["w4", "w4", "w5", "w6", "w9", "w9", "w7"][i], state));
  assert.equal(new Set(lines).size, lines.length);
  assert.equal(lines[0], "w4: on, MAC on port 17");
  assert.match(lines[1], /w4's MAC is on port 17, not its own port 9/);
  assert.equal(lines[2], "w5: off, link up 100 Mb, no MAC on port 18");
  assert.equal(lines[3], "w6: off, link down on port 14");
});

test("NO LINE EVER SAYS \"armed\": link up in S5 may mean only that the NIC has power (#3242)", async () => {
  const lines = (await Promise.all(await everyState())).map((state) => switchLine("w4", state));
  assert.ok(lines.length >= 7, "a control: every state was rendered");
  for (const line of lines) assert.doesNotMatch(line, /armed/i);
  assert.doesNotMatch(switchReport([], { ok: false, reason: "r" }).lines.join(), /armed/i);
});

test("a switch that does not answer is ONE unread line that says the worker readings are unaffected", () => {
  const states = ["w2", "w3", "w4"].map((name) => ({ name, state: { kind: "unread" as const, reason: "no answer" } }));
  const report = switchReport(states, { ok: false, reason: "the switch did not answer (no answer)" });
  assert.equal(report.lines.length, 1);
  assert.match(report.lines[0], /switch: unread .*the worker readings below are unaffected/);
});

test("a fleet with no switch_port anywhere says so once", () => {
  const states = ["w2", "w3"].map((name) => ({ name, state: { kind: "unmapped" as const, reason: "no switch_port in the inventory" } }));
  const readings = { ok: true as const, table: "t", macToPorts: new Map(), linkByPort: new Map(), speedByPort: new Map(), linkUnread: null, ifIndexIsPort: true };
  assert.deepEqual(switchReport(states, readings).lines, ["switch: not read (no worker declares switch_port in the inventory)"]);
});

// --- configuration and the inventory ------------------------------------------------------------------

test("the switch is configured by env, then by file, and with neither it is null: there is no default", () => {
  const file = (text: string) => () => text;
  const refuse = () => { throw new Error("ENOENT"); };
  assert.deepEqual(readSwitchConfig({ env: { A11Y_SWITCH_HOST: "h", A11Y_SWITCH_COMMUNITY: "c" }, readFile: refuse }), { host: "h", community: "c" });
  assert.deepEqual(readSwitchConfig({ env: {}, readFile: file("# c\nhost = 203.0.113.9\ncommunity=s e\n") }), { host: "203.0.113.9", community: "s e" });
  assert.deepEqual(readSwitchConfig({ env: { A11Y_SWITCH_HOST: "env" }, readFile: file("host=file\ncommunity=c\n") }), { host: "env", community: "c" });
  assert.equal(readSwitchConfig({ env: {}, readFile: refuse }), null);
  assert.equal(readSwitchConfig({ env: { A11Y_SWITCH_HOST: "h" }, readFile: refuse }), null, "an address with no community is not a configuration");
});

const INVENTORY = `all:
  children:
    a11y_workers:
      hosts:
        a11y-worker-4:
          ansible_host: 192.0.2.14
          mac: "aa:bb:cc:00:00:04"
          switch_port: 17
        a11y-worker-5:
          ansible_host: 192.0.2.15
          mac: "aa:bb:cc:00:00:05"
          # switch_port: 99
        a11y-worker-6:
          ansible_host: 192.0.2.16
          switch_port: 14  # w6
    other_hosts:
      hosts:
        agents:
          ansible_host: 192.0.2.99
          switch_port: 13
`;

test("switch_port is read per worker host; a commented one, an absent one and another group's are not", () => {
  assert.deepEqual([...switchPortsByHost(INVENTORY)], [["192.0.2.14", 17], ["192.0.2.16", 14]]);
});

// --- the live reader, with the transport and the inventory handed in ----------------------------------

const fleetRows = [
  { name: "a11y-worker-4  192.0.2.14", url: "http://192.0.2.14:8765" },
  { name: "a11y-worker-5  192.0.2.15", url: "http://192.0.2.15:8765" },
  { name: "a11y-worker-6  192.0.2.16", url: "http://192.0.2.16:8765", mac: "aa:bb:cc:00:00:06" },
];

test("the live reader gives one line per worker from the inventory's ports and MACs", async () => {
  const report = await readSwitchLive(fleetRows, { config: { host: "h", community: "c" }, readInventories: () => [INVENTORY],
    send: fakeSwitch(FLEET).send });
  assert.deepEqual(report.lines, [
    "a11y-worker-4: on, MAC on port 17",
    "a11y-worker-5: not read (no switch_port in the inventory)",
    "a11y-worker-6: off, link down on port 14",
  ]);
  assert.equal(report.table, "BRIDGE-MIB dot1dTpFdbPort");
  assert.equal(report.ifIndexIsPort, true);
});

test("the live reader NEVER THROWS: a silent switch, an unreadable inventory and no configuration are each an unread report", async () => {
  const silent = await readSwitchLive(fleetRows, { config: { host: "h", community: "c" }, readInventories: () => [INVENTORY],
    send: async () => { throw new Error("no reply in 2000 ms x 2"); } });
  const noInventory = await readSwitchLive(fleetRows, { config: { host: "h", community: "c" },
    readInventories: () => { throw new Error("the control plane's inventory could not be read"); } });
  let sent = 0;
  const unconfigured = await readSwitchLive(fleetRows, { config: null, send: async () => { sent += 1; return Buffer.alloc(0); } });
  assert.match(silent.lines[0], /switch: unread \(the switch did not answer \(no reply/);
  assert.match(noInventory.lines[0], /switch: unread \(the switch could not be read: the control plane's inventory/);
  assert.match(unconfigured.lines[0], /switch: unread \(no switch configured/);
  assert.equal(sent, 0, "with no configuration nothing is sent");
  assert.equal(silent.states.length, 3, "every worker still has a state");
});

test("the community never appears in anything the reader returns", async () => {
  const secret = "s3cret-community";
  const reports = [
    await readSwitchLive(fleetRows, { config: { host: "h", community: secret }, readInventories: () => [INVENTORY], send: fakeSwitch(FLEET).send }),
    await readSwitchLive(fleetRows, { config: { host: "h", community: secret }, readInventories: () => [INVENTORY],
      send: async () => { throw new Error("no reply"); } }),
  ];
  for (const report of reports) assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  const sent = fakeSwitch(FLEET);
  await readSwitchLive(fleetRows, { config: { host: "h", community: secret }, readInventories: () => [INVENTORY], send: sent.send });
  assert.ok(sent.packets[0].includes(Buffer.from(secret)), "a control: the community IS on the wire, which is the only place it goes");
});
