// @ts-check
/**
 * WHERE A LAYER'S CODE LIVES ON THIS HOST, asked of one place (ADR 0039 item 6, #3394).
 *
 * The control plane reads the worker's code version to decide whether the fleet runs the right build, and it
 * used to find the worker by a relative path into its source directory. Control runs from a raw checkout
 * with no `node_modules` (ADR 0012), so it cannot use the package name; and once the layer leaves this
 * repository, a reader that guessed the monorepo path would compare the fleet against the WRONG tree and
 * still print a hash. `layers.json` declares each layer and its path, and this module is the only reader.
 *
 * REFUSES rather than falls back. An undeclared layer, or a declared one whose directory is not there, throws
 * naming the layer and the path: answering with the monorepo path instead is the silent wrong answer this
 * exists to remove.
 *
 * Imports only `node:` modules, so `control-has-no-dependencies.test.ts` holds. `layerCodeVersion` therefore
 * imports the layer's own `code-version.mjs` DYNAMICALLY, from the resolved directory: still the one hasher,
 * and a static import would name the path this module exists to hide.
 *
 * A layer that lives in its OWN repository declares a `remote`, and a guest then holds a second checkout of it
 * pinned to its own commit (ADR 0039 item 6, row 6b, #3395): `separateLayers` names those, and `layerPins`
 * turns the operator's `--layer-ref=<name>=<sha>` flags into the pair's second half, refusing a missing pin, a
 * short sha and a layer that has no repository of its own. The guest plays read the SAME manifest themselves
 * (`ansible/tasks/read-layer-checkouts.yml`), so the two cannot name different layers.
 *
 * THE CONTROL PLANE AND THE LAB MOVE THE LAYER'S CHECKOUT BESIDE THE CORE'S (row 6c, #3396). `layerCheckoutMove`
 * is the control plane's half: the shell that puts each separate layer's checkout on its pinned commit and reads
 * the commit back, REFUSING (exit 4) where the checkout is not there rather than leaving the core's tree to
 * answer for it. The lab's half is `ansible/tasks/run-job.yml` and `lab-reset.yml`, which read the same
 * manifest and validate a layer's ref with `LAYER_REF`, which is `lab_ref`'s own pattern. With no layer that
 * declares a `remote`, every one of them is a no-op, which is the state today.
 *
 * A HOST THAT HAS INSTALLED HOLDS A SEPARATE LAYER LAID, NOT CLONED (#3819): `scripts/lay-layer.mjs` replaces the clone with `src/`
 * and `.layer-ref`. The lab's and the guests' tasks accept that shape; `layerCheckoutMove` does not need to, because the control
 * plane's checkout never installs (ADR 0012), so nothing lays there and a missing `.git` still means a missing checkout.
 *
 * `worker-fleet` does NOT use this: it is published and `control` never is
 * (`worker-fleet-does-not-read-control.test.ts`), so its readers ask the worker package by name instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL("../layers.json", import.meta.url), "utf8"));

/**
 * Where the control plane's own code is laid, when `layers.json` declares `pinned.control` (#3914): `packages/control` is then a laid
 * copy of `a11ign/control` at a tag and no part of this repository's tree (#3506). Null while it declares none, which is every
 * checkout until that lands, so nothing that reads it changes before then.
 *
 * @param {{ manifest: { pinned?: Record<string, { path: string }> }, root: string }} from
 * @returns {{ name: string, path: string, dir: string } | null}
 */
function laidControlOf({ manifest, root }) {
  const declared = manifest.pinned && Object.hasOwn(manifest.pinned, CONTROL_LAYER) ? manifest.pinned[CONTROL_LAYER] : undefined;
  return declared ? { name: CONTROL_LAYER, path: declared.path, dir: resolve(root, declared.path) } : null;
}

/**
 * The name of the layer whose directory is `path` or holds it. `startsWith` of the directory and a slash, so a sibling that shares a
 * prefix (`packages/control-extra`) is not inside it.
 *
 * @param {string} path repo-relative
 * @param {({ name: string, path: string } | null)[]} layers a null is a layer that is not declared, and owns nothing
 * @returns {string | null}
 */
function owningLayer(path, layers) {
  return layers.find((layer) => layer !== null && (path === layer.path || path.startsWith(`${layer.path}/`)))?.name ?? null;
}

/**
 * The resolver over one manifest and one repository root. The exports below close over the real ones; a test
 * closes over a fixture, which is how "a declared layer whose path is absent" is reachable at all.
 *
 * @param {{ manifest: { layers: Record<string, { path: string, remote?: string, branch?: string }>, pinned?: Record<string, { path: string, tag?: string }> }, root: string }} from
 */
export function layersFrom({ manifest, root }) {
  /**
   * What `layers.json` declares for a layer, WITHOUT asking whether its directory is there: the refusal for a
   * missing clone has to name where the clone goes, and `layerRoot` throws before it can.
   * @param {string} name
   * @returns {{ name: string, path: string, remote: string | undefined, dir: string }}
   */
  function layerDeclaration(name) {
    const layer = Object.hasOwn(manifest.layers, name) ? manifest.layers[name] : undefined;
    if (!layer) {
      throw new Error(`layer "${name}" is not declared in packages/control/layers.json `
        + `(declared: ${Object.keys(manifest.layers).join(", ") || "none"})`);
    }
    return { name, path: layer.path, remote: layer.remote, dir: resolve(root, layer.path) };
  }

  /** The layer's directory: where its `package.json` and its `src/` are. @param {string} name */
  function layerRoot(name) {
    const { path, dir } = layerDeclaration(name);
    if (!existsSync(dir)) {
      throw new Error(`layer "${name}" is declared at ${path}, and ${dir} does not exist: `
        + "check it out there, or correct its path in packages/control/layers.json");
    }
    return dir;
  }

  /** The layer's source directory, the one `codeVersion` hashes. Trailing slash, as `workerSourceDir()`. @param {string} name */
  const layerSourceDir = (name) => `${join(layerRoot(name), "src")}/`;

  /** The layer's code hash, computed by the layer's own hasher. @param {string} name */
  async function layerCodeVersion(name) {
    const hasher = await import(pathToFileURL(join(layerSourceDir(name), "code-version.mjs")).href);
    return hasher.codeVersion(layerSourceDir(name));
  }

  /** The layers a guest holds as a second checkout: those that declare a `remote`. */
  const separateLayers = () => Object.entries(manifest.layers).filter(([, layer]) => layer.remote).map(([name]) => name);

  /**
   * The operator's `--layer-ref=<name>=<full sha>` values as `{ name: sha }`, or the refusal to print.
   * A layer is pinned by a FULL sha (the guest asserts `rev-parse HEAD` equals it, which an abbreviation never
   * would), every separate layer must be pinned (no default: a guessed layer commit is a wrong answer about a
   * repository nobody named), and a layer inside the core checkout is refused, because the core's pin already
   * moved it and a second pin would say two things about one directory.
   *
   * @param {string[]} given
   * @returns {{ pins: Record<string, string>, refusal: string | null }}
   */
  function layerPins(given) {
    const separate = separateLayers();
    /** @type {Record<string, string>} */
    const pins = {};
    for (const value of given) {
      const match = /^([a-z0-9-]+)=([0-9a-f]{40})$/.exec(value);
      if (!match) return refused(`--layer-ref=${value}: <layer name>=<40 lowercase hex>, a full commit.`);
      const [, name, sha] = match;
      if (!separate.includes(name)) {
        return refused(`--layer-ref=${value}: "${name}" is not a layer with its own repository `
          + `(those are: ${separate.join(", ") || "none"}). A layer inside the core checkout moves with the core's commit.`);
      }
      if (Object.hasOwn(pins, name)) return refused(`--layer-ref names "${name}" twice.`);
      pins[name] = sha;
    }
    const unpinned = separate.filter((name) => !Object.hasOwn(pins, name));
    if (unpinned.length) {
      return refused(`${unpinned.join(", ")} lives in its own repository and needs a pin: `
        + unpinned.map((name) => `--layer-ref=${name}=<40 hex>`).join(" "));
    }
    return { pins, refusal: null };
  }

  /** @param {Record<string, string>} pins a value that has passed `layerPins` */
  const layerCheckoutMove = (pins) => checkoutMoveFor(manifest, pins);

  /** The laid control, or null while `layers.json` declares none (`laidControlOf`). */
  const laidControl = () => laidControlOf({ manifest, root });

  /**
   * The layer whose directory holds `path` (repo-relative): a separate layer, or the laid control, or null when it is the core's.
   * A file of a layer's is not tracked by this repository, so "does `git ls-files` list it" cannot be the question asked of it (#3845).
   * @param {string} path
   * @returns {string | null}
   */
  function layerOwning(path) {
    const separate = separateLayers().map((name) => ({ name, path: manifest.layers[name].path }));
    return owningLayer(path, [...separate, laidControl()]);
  }

  return { layerDeclaration, layerRoot, layerSourceDir, layerCodeVersion, separateLayers, layerPins, layerCheckoutMove, layerOwning, laidControl };
}

/** The key of the control plane's own code in `layers.json`'s `pinned` section: the one pinned layer the closure of `fleet:auto-off` runs from (#3914). */
export const CONTROL_LAYER = "control";

/** What a declared tag looks like: `scripts/lay-layer.mjs`'s `DECLARED_TAG`, which this directory cannot import (ADR 0012). A branch or a sha is not a pin. */
const DECLARED_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * The tag a `pinned` layer is laid at, read from the text of a `layers.json` (`origin/main`'s, for the stale-checkout guard): the
 * declaration's own `tag`, which is what `scripts/lay-layer.mjs`'s `tagToLay` lays. A manifest that is not JSON, a layer it does
 * not pin, or a tag that is not `v<semver>` is a refusal, never a default.
 *
 * @param {string} manifestText
 * @param {string} layer a key of `layers.json`'s `pinned`
 * @returns {{ tag: string } | { refusal: string }}
 */
export function pinnedLayerTag(manifestText, layer) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (cause) {
    return { refusal: `layers.json is not JSON (${cause instanceof Error ? cause.message : cause})` };
  }
  const pinned = manifest?.pinned;
  const declared = pinned && typeof pinned === "object" && Object.hasOwn(pinned, layer) ? pinned[layer] : undefined;
  if (declared === undefined) return { refusal: `layers.json declares no pinned layer ${layer}` };
  if (typeof declared.tag !== "string" || !DECLARED_TAG.test(declared.tag)) {
    return { refusal: `layers.json pins ${layer} at ${JSON.stringify(declared.tag)}, which is not a v<semver> tag: a branch or a sha is not a pin` };
  }
  return { tag: declared.tag };
}

/**
 * The tag a layer is laid at, read from the text of the core's `pnpm-lock.yaml`: `scripts/lay-layer.mjs`'s `pinnedVersion` and
 * `layingPlan` over again, because `control` imports nothing outside its own directory (ADR 0012) and that script imports the guards.
 * `fleet-auto-off.test.ts` holds the two readings equal on the real lockfile, so they cannot name two builds (#3845).
 * A lockfile with no registry entry for the layer is a refusal, never a default.
 *
 * @param {string} lockfile
 * @param {string} layer a key of `layers.json`
 * @returns {{ tag: string } | { refusal: string }}
 */
export function layerPinTag(lockfile, layer) {
  const name = `@a11ign/${layer}`;
  const entry = new RegExp(`^ {6}'${name.replace(/[/.]/g, "\\$&")}':\\r?\\n {8}specifier: [^\\r\\n]+\\r?\\n {8}version: ([^\\r\\n]+)$`, "m");
  const block = lockfile.match(entry);
  if (!block) return { refusal: `pnpm-lock.yaml has no importer entry for ${name}` };
  const version = block[1].replace(/\(.*$/, "");
  if (!/^\d+\.\d+\.\d+/.test(version)) return { refusal: `${name} is "${version}" in pnpm-lock.yaml, not a registry release: there is no tag to lay` };
  return { tag: `${name}@${version}` };
}

/**
 * The shell that moves each pinned layer's checkout on the control plane, beside the core's, to its commit,
 * and compares `rev-parse HEAD` with the pin. Appended after the core's own move, so the pair lands or the
 * command fails: a layer left where its branch was is the silent half of the pair (#3395's guest failure).
 *
 * A checkout that is NOT THERE refuses, naming the layer and the path, and never `git`s the core's tree in
 * its place: the monorepo layout answering for a layer that moved is the substitution this exists to stop.
 * A path is restricted to `[A-Za-z0-9._/-]` with no `..` and a pin was restricted by `layerPins` to 40 hex
 * digits, so nothing that reaches the string can close its quotes.
 *
 * @param {{ layers: Record<string, { path: string, remote?: string, branch?: string }> }} manifest
 * @param {Record<string, string>} pins a value that has passed `layerPins`
 * @returns {string} the argv fragment, leading space included, or "" when nothing is pinned
 */
function checkoutMoveFor(manifest, pins) {
  return Object.entries(pins).map(([name, sha]) => {
    const layer = Object.hasOwn(manifest.layers, name) ? manifest.layers[name] : undefined;
    if (!layer?.remote) throw new Error(`layer "${name}" has no repository of its own to move`);
    if (!LAYER_REF.test(layer.path) || layer.path.includes("..")) {
      throw new Error(`layer "${name}" is declared at "${layer.path}", which is not a plain relative path`);
    }
    // `cd` names the checkout's own export, which is the form `control-plane-checkout-is-one-fact.test.ts` reads.
    const where = `${CONTROL_PLANE_CHECKOUT_PATH}/${layer.path}`;
    return ` && ( [ -d ${where}/.git ] || { echo "REFUSING: layer ${name} is declared at ${layer.path} and ${where} `
      + "is not a git checkout; the core's tree does not stand in for it. Run bootstrap-control-plane.sh.\" >&2; exit 4; } ) "
      + `&& ( cd ${CONTROL_PLANE_CHECKOUT_PATH}/${layer.path} && git fetch --quiet origin && git checkout --quiet --detach ${sha} `
      + `&& test "$(git rev-parse HEAD)" = ${sha} )`;
  }).join("");
}

/** @param {string} refusal @returns {{ pins: Record<string, string>, refusal: string }} */
function refused(refusal) {
  return { pins: {}, refusal: `refusing ${refusal}` };
}

/**
 * What a layer's ref may look like on the lab and on the control plane: `run-job.yml`'s `lab_ref` pattern, as a
 * value, so a test can hold the two spellings equal. A ref is a plain name or a commit, never a path out.
 */
export const LAYER_REF = /^[A-Za-z0-9._/-]{1,100}$/;

const declared = layersFrom({ manifest: MANIFEST, root: REPO_ROOT });
export const layerDeclaration = declared.layerDeclaration;
export const layerRoot = declared.layerRoot;
export const layerSourceDir = declared.layerSourceDir;
export const layerCodeVersion = declared.layerCodeVersion;
export const separateLayers = declared.separateLayers;
export const layerPins = declared.layerPins;
export const layerCheckoutMove = declared.layerCheckoutMove;
export const layerOwning = declared.layerOwning;
export const laidControl = declared.laidControl;

/**
 * Every `--layer-ref=<name>=<sha>`, in order. REPEATABLE, which `flagValue` (first match only) is not: one
 * layer per flag, so the pair grows by a flag per layer rather than by a packed value.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function layerRefValues(argv) {
  const prefix = "--layer-ref=";
  return argv.filter((argument) => argument.startsWith(prefix)).map((argument) => argument.slice(prefix.length));
}

/** The playbooks that move a guest's checkout and so hold a layer's second half of the pair (#3395). */
const LAYER_PINNED = ["deploy.yml", "provision-role.yml"];

/**
 * The refusal for `--layer-ref` on a playbook that pins no layer, or for a layer left unpinned on one that does;
 * else the pins. Silently dropping a pin the operator typed is the failure `refuseUnknownFlags` exists to end.
 *
 * @param {{ chosen: string, given: string[] }} args
 * @returns {{ pins: Record<string, string>, refusal: string | null }}
 */
export function layerPinsFor({ chosen, given }) {
  if (!LAYER_PINNED.includes(chosen)) {
    return { pins: {}, refusal: given.length
      ? `refusing --layer-ref with --playbook=${chosen}: only ${LAYER_PINNED.join(" and ")} pin a layer.` : null };
  }
  return layerPins(given);
}

/**
 * The one `-e` that carries the layers' half of the commit pair, or "" when no layer has its own repository.
 * Single-quoted for the remote shell that parses this string; `layerPins` has already restricted every name to
 * `[a-z0-9-]` and every sha to 40 hex digits, so nothing that reaches here can close the quote.
 *
 * @param {Record<string, string>} pins a value that has passed `layerPinsFor`
 * @returns {string} the argv fragment, leading space included, or ""
 */
export function layerCommitsExtraVars(pins) {
  if (!Object.keys(pins).length) return "";
  return ` -e '${JSON.stringify({ a11y_layer_commits: pins })}'`;
}
