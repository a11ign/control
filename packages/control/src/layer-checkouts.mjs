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
 * @param {{ manifest: { layers: Record<string, { path: string }> }, root: string }} from
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

  return { layerRoot, layerSourceDir, layerCodeVersion };
}

const declared = layersFrom({ manifest: MANIFEST, root: REPO_ROOT });
export const layerRoot = declared.layerRoot;
export const layerSourceDir = declared.layerSourceDir;
export const layerCodeVersion = declared.layerCodeVersion;
