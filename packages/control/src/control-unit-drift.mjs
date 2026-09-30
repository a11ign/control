// @ts-check
/**
 * Does the control host RUN the unit text the repository ships? -- #2800, the first half of #2784 done-when 3.
 *
 * Found on #2784, 2026-09-30: the units installed on the control host were the #2656 copies while the
 * repository and the control checkout already held the #2734 ones, and nobody noticed for two days.
 * `hostUnitDrift` (`agent-org/src/host-units.mjs`) compares installed units to their source for the AGENTS
 * host only; nothing read the control host. **The installed copy is the program**: a green suite over the
 * source says nothing about which text the control host executes, and the only reading that does is one
 * taken FROM the host.
 *
 * This is a NEW module beside `hostUnitDrift`, not a widening of it (another row edits that file). It reuses
 * the finding shape -- one finding per unit, naming the unit and what is wrong -- and none of its code.
 *
 * ## Three kinds of finding, and a fourth state that is not a finding
 *
 *   - `differs`         installed on the host, and its text is not the shipped text
 *   - `missing-on-host` shipped by a control-plane playbook, absent on the host (never installed)
 *   - `not-shipped`     an `a11y-*` unit on the host that no control-plane playbook ships (a stale leftover)
 *   - `CANNOT_TELL`     the host could not be read. NEVER `CLEAN` and never an empty list: an unresolvable
 *                       name, a refused key and an empty answer all mean "I did not look", and a watch
 *                       that reads "no drift" off a failed read is the defect this file exists to end.
 *
 * ## The compared set is DERIVED from the playbooks, not typed here
 *
 * `shippedControlUnits` reads every playbook and takes the unit names listed by each play whose `hosts:` is
 * `a11y_control` and which copies `files/{{ item }}` into `/etc/systemd/system`. A unit pair added to such a
 * playbook tomorrow is compared without anyone editing this file. The lab's units (`corpus-schedule.yml`,
 * `hosts: a11y_lab`) are deliberately NOT compared here: they are not on this host, and counting them would
 * report them `missing-on-host` forever.
 *
 * A derivation that finds NOTHING is `CANNOT_TELL` too. A play reshaped so the scan no longer recognises it
 * would otherwise read as "the control host ships no units, so no unit drifts" -- vacuous, and green.
 *
 * No third-party dependency: this package runs from a raw checkout with no `npm install`
 * (`control-has-no-dependencies.test.ts`), so the playbooks are read as text, not parsed as YAML.
 */
import { readFileSync, readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sshToControlPlane } from "./control-plane-fleet.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ANSIBLE_DIR = join(HERE, "..", "ansible");
const FILES_DIR = join(ANSIBLE_DIR, "files");
const INSTALLED_DIR = "/etc/systemd/system";

/** Exit codes are the contract, `fleet-watch`'s tristate: 0 quiet, 1 attention, 2 could not ask. */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

export const VERDICT = { CLEAN: "CLEAN", DRIFT: "DRIFT", CANNOT_TELL: "CANNOT_TELL" };

export const KIND = { DIFFERS: "differs", MISSING: "missing-on-host", NOT_SHIPPED: "not-shipped" };

/** The prefix every unit this repo installs carries, so a foreign unit on the host is nobody's finding. */
const OUR_UNIT = /^a11y-[\w.@-]+\.(?:service|timer)$/;

/** A list item that names a unit file: `      - a11y-fleet-auto-off.timer`. */
const UNIT_LIST_ITEM = /^\s*-\s+["']?([\w.@-]+\.(?:service|timer))["']?\s*$/gm;

/** @typedef {{ unit: string, kind: string, detail: string }} Finding */
/** @typedef {{ verdict: string, findings: Finding[], reason?: string }} Reading */
/** @typedef {{ units: string[] } | { cannotTell: string }} Derivation */

/**
 * @param {string} playbook
 * @returns {string[]} each play's text, split at the top-level `- name:` that opens it
 */
function playsOf(playbook) {
  return playbook.split(/^(?=- name:)/m).filter((play) => play.startsWith("- name:"));
}

/** @param {string} play */
const targetsTheControlPlane = (play) => /^\s{2}hosts:\s*["']?a11y_control["']?\s*$/m.test(play);

/** A play installs units when it copies from `files/` into systemd's directory. @param {string} play */
const installsUnits = (play) => /src:\s*["']?files\/\{\{\s*item\s*\}\}/.test(play)
  && play.includes(`${INSTALLED_DIR}/{{ item }}`);

/** @param {string} play */
const unitNamesIn = (play) => [...play.matchAll(UNIT_LIST_ITEM)].map((match) => match[1]);

/**
 * The unit names the control-plane playbooks install, derived from the playbooks' own text.
 * @param {{ playbooks: () => string[] }} source each playbook's text
 * @returns {Derivation}
 */
export function deriveShippedUnits({ playbooks }) {
  const installing = playbooks().flatMap(playsOf).filter(targetsTheControlPlane).filter(installsUnits);
  const units = [...new Set(installing.flatMap(unitNamesIn))].sort();
  if (installing.length === 0) return { cannotTell: "no playbook play targeting a11y_control installs unit files, so there is nothing derived to compare" };
  if (units.length === 0) return { cannotTell: "a play installs unit files on a11y_control but names none this reader recognises" };
  return { units };
}

/**
 * @param {{ playbooks: () => string[], shippedText: (unit: string) => string }} source
 * @returns {{ shipped: Record<string, string> } | { cannotTell: string }}
 */
export function shippedControlUnits(source) {
  const derived = deriveShippedUnits(source);
  if ("cannotTell" in derived) return derived;
  try {
    return { shipped: Object.fromEntries(derived.units.map((unit) => [unit, source.shippedText(unit)])) };
  } catch (error) {
    return { cannotTell: `a derived unit has no readable repository copy: ${errorText(error)}` };
  }
}

/** @param {unknown} error */
const errorText = (error) => (error instanceof Error ? error.message : String(error));

/**
 * One finding per unit that differs, is missing on the host, or is on the host and not shipped.
 * @param {Record<string, string>} shipped
 * @param {Record<string, string>} installed
 * @returns {Finding[]}
 */
export function compareUnits(shipped, installed) {
  /** @type {Finding[]} */
  const findings = [];
  for (const [unit, text] of Object.entries(shipped)) {
    if (!(unit in installed)) findings.push({ unit, kind: KIND.MISSING, detail: `${unit} is shipped by a control-plane playbook and is not installed on the control host` });
    else if (installed[unit] !== text) findings.push({ unit, kind: KIND.DIFFERS, detail: `${unit} on the control host is not the repository's copy` });
  }
  for (const unit of Object.keys(installed)) {
    if (!(unit in shipped) && OUR_UNIT.test(unit)) findings.push({ unit, kind: KIND.NOT_SHIPPED, detail: `${unit} is installed on the control host and no control-plane playbook ships it` });
  }
  return findings.sort((a, b) => a.unit.localeCompare(b.unit));
}

/** @param {string} reason @returns {Reading} */
const cannotTell = (reason) => ({ verdict: VERDICT.CANNOT_TELL, findings: [], reason });

/**
 * Read the control host and compare. `readHost` returns `{ [unit file name]: text }` for every `a11y-*`
 * unit installed there, and THROWS when it could not look; anything but a non-empty object is an empty
 * answer. A host that runs the fleet's timers and lists no unit at all is indistinguishable from a read
 * that silently returned nothing, so it is `CANNOT_TELL` rather than "everything is missing".
 *
 * @param {{ readHost: () => Record<string, string> | null | undefined, playbooks: () => string[],
 *   shippedText: (unit: string) => string }} deps
 * @returns {Reading}
 */
export function controlUnitDrift(deps) {
  const shipped = shippedControlUnits(deps);
  if ("cannotTell" in shipped) return cannotTell(shipped.cannotTell);
  let installed;
  try {
    installed = deps.readHost();
  } catch (error) {
    return cannotTell(`the control host could not be read: ${errorText(error)}`);
  }
  if (!installed || typeof installed !== "object" || Object.keys(installed).length === 0) {
    return cannotTell("the control host answered with no unit files, which is an empty answer and not a clean reading");
  }
  const findings = compareUnits(shipped.shipped, installed);
  return { verdict: findings.length === 0 ? VERDICT.CLEAN : VERDICT.DRIFT, findings };
}

/** Marks the end of the listing, so a truncated or empty ssh answer cannot pass for a short one. */
const END_MARK = "--end-of-units--";

/**
 * One command, one line per unit -- `<name> <base64 of the file>` -- so a unit's own text can never be
 * mistaken for a delimiter, ended by `END_MARK`.
 */
const LIST_COMMAND = `cd ${INSTALLED_DIR} && for f in a11y-*.service a11y-*.timer; do `
  + `[ -f "$f" ] && printf '%s %s\\n' "$f" "$(base64 -w0 "$f")"; done; echo ${END_MARK}`;

/**
 * @param {string} output what `LIST_COMMAND` printed
 * @returns {Record<string, string>}
 */
export function parseHostListing(output) {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.at(-1) !== END_MARK) throw new Error("the listing did not end where it should, so it may be truncated");
  return Object.fromEntries(lines.slice(0, -1).map((line) => {
    const [unit, encoded = ""] = line.split(" ");
    return [unit, Buffer.from(encoded, "base64").toString("utf8")];
  }));
}

/** The real host reader: ssh (or local, on the control plane itself) through `sshToControlPlane`. */
export const readControlHost = () => parseHostListing(sshToControlPlane(LIST_COMMAND, { capture: true }));

/** The real playbooks and repository unit files, read from this checkout. */
export const checkoutSource = {
  playbooks: () => readdirSync(ANSIBLE_DIR).filter((name) => name.endsWith(".yml"))
    .map((name) => readFileSync(join(ANSIBLE_DIR, name), "utf8")),
  shippedText: (/** @type {string} */ unit) => readFileSync(join(FILES_DIR, basename(unit)), "utf8"),
};

/** Wide enough for the longest kind, `missing-on-host`, plus a space. */
const KIND_COLUMN = 16;

/** @param {Reading} reading */
export function report({ verdict, findings, reason }) {
  if (verdict === VERDICT.CANNOT_TELL) return `CANNOT_TELL: ${reason}\n`;
  if (verdict === VERDICT.CLEAN) return "CLEAN: every unit the control-plane playbooks ship is installed on the control host as shipped\n";
  return `DRIFT: ${findings.length} unit(s)\n${findings.map((f) => `  ${f.kind.padEnd(KIND_COLUMN)} ${f.detail}`).join("\n")}\n`;
}

/** @param {Reading} reading */
export const exitCodeFor = ({ verdict }) =>
  verdict === VERDICT.CLEAN ? EXIT.QUIET : verdict === VERDICT.DRIFT ? EXIT.ATTENTION : EXIT.CANNOT_ASK;

function main() {
  const reading = controlUnitDrift({ readHost: readControlHost, ...checkoutSource });
  process.stdout.write(report(reading));
  process.exit(exitCodeFor(reading));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
