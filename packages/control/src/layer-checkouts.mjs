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
 * `worker-fleet` does NOT use this: it is published and `control` never is
 * (`worker-fleet-does-not-read-control.test.ts`), so its readers ask the worker package by name instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL("../layers.json", import.meta.url), "utf8"));

/**
 * The resolver over one manifest and one repository root. The exports below close over the real ones; a test
 * closes over a fixture, which is how "a declared layer whose path is absent" is reachable at all.
 *
 * @param {{ manifest: { layers: Record<string, { path: string, remote?: string, branch?: string }> }, root: string }} from
 */
export function layersFrom({ manifest, root }) {
  /** The layer's directory: where its `package.json` and its `src/` are. @param {string} name */
  function layerRoot(name) {
    const layer = Object.hasOwn(manifest.layers, name) ? manifest.layers[name] : undefined;
    if (!layer) {
      throw new Error(`layer "${name}" is not declared in packages/control/layers.json `
        + `(declared: ${Object.keys(manifest.layers).join(", ") || "none"})`);
    }
    const dir = resolve(root, layer.path);
    if (!existsSync(dir)) {
      throw new Error(`layer "${name}" is declared at ${layer.path}, and ${dir} does not exist: `
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

  return { layerRoot, layerSourceDir, layerCodeVersion, separateLayers, layerPins };
}

/** @param {string} refusal @returns {{ pins: Record<string, string>, refusal: string }} */
function refused(refusal) {
  return { pins: {}, refusal: `refusing ${refusal}` };
}

const declared = layersFrom({ manifest: MANIFEST, root: REPO_ROOT });
export const layerRoot = declared.layerRoot;
export const layerSourceDir = declared.layerSourceDir;
export const layerCodeVersion = declared.layerCodeVersion;
export const separateLayers = declared.separateLayers;
export const layerPins = declared.layerPins;

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
