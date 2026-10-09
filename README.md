# `@a11ign/control`

**Private. Never published to a registry.** The control plane: the one machine that holds the fleet SSH key and can provision, deploy, wake and sleep the ten bare-metal capture workers. See
[ADR 0012](https://github.com/a11ign/a11ign/blob/main/docs/adr/0012-control-plane-split.md) for why this is a separate credential domain from `lab` (the corpus/training machine) rather than one
box doing both. Moved here from [`a11ign/a11ign`](https://github.com/a11ign/a11ign) with its history (`packages/control`, 375 commits); the package is this repository's root.
**AGPL-3.0-or-later**, with the core's [`LICENSE`](LICENSE) byte for byte (`control` shipped none of its own).

**This code reconfigures real Windows machines over SSH.** Read `SECURITY.md` in `a11ign/a11ign` before running any of it.

**No `dependencies`, and that is enforced, not aspirational.** `scripts/package-manifest.test.ts` asserts the `package.json` dependency list is empty, and `src/control-has-no-dependencies.test.ts` that
nothing is imported by package name — the credential that can reconfigure twelve Windows boxes must not sit behind npm's transitive dependency surface. The ADR made this claim in prose first and it was
violated on both machines it described before anyone checked. The `devDependencies` are this repository's own tooling and the control plane never installs them.

```
src/                   fleet-playbook.mjs   drives Ansible against the fleet: provision, deploy, wake/sleep
                       lab-pipeline.mjs     sequences ordered stages (deploy -> capture -> gates) as one unit
                       lab-job.mjs          dispatches one named long-running job on the lab, over Ansible
                       fleet-status.mjs     what every worker is doing right now
                       fleet-discover.mjs   scans the subnet against inventory.yml, reports drift
                       fleet-wake.mjs       power the fleet on (Wake-on-LAN) or check it answered
ansible/               the playbooks themselves, and ansible/README.md is the map:
                       why SSH and not WinRM, why the fleet is defined once in inventory.yml
layers.json            where each layer's code lives (read through src/layer-checkouts.mjs)
scripts/               this repository's own tests: the workflows, the arming filter, the manifest
```

Exports three entry points other packages import: `./fleet-playbook`, `./lab-pipeline` and `./fleet-wake` (#2682: `packages/lab`'s by-hand entries wake exactly the workers they name, the same
credential-free call `fleet-wake.mjs`'s own CLI makes), and `./layer-checkouts`.

## Reaching the control plane itself

`fleet-playbook.mjs` and `lab-pipeline.mjs` both SSH into the control-plane machine to run Ansible there —
that machine holds the fleet key, so the command has to run on it rather than merely be issued from
wherever you are. Two variables name that connection, and **both are REQUIRED — neither has a default**:

- `A11Y_CONTROL_HOST` — the control plane's address.
- `A11Y_PVE_KEY` — the SSH private key used to reach it.

Both used to fall back to a real, specific value baked into this file (this deployment's own host and key
filename), which is exactly the policy violation the paragraph below describes — a real credential sitting
in public git history, reached by anyone who never set the variable. `requireControlPlaneHost()` (#83) and
`requireControlPlaneKey()` (#85) now REFUSE rather than guess when either is unset, and there is
deliberately no default here to replace what was removed.

Neither is documented **as a specific value** anywhere public: this repo is meant to be generic, and one
deployment's control-host address and key filename are not the project's — the same reason the tailnet ACL
and `*.local.yml` are gitignored. If you are standing up your own control plane, set both to point at it;
if you are working in this checkout against an existing one, you already have — or need to be given — the
values, and they do not belong in git.

`A11Y_CONTROL_HOST` has a third state beyond "unset" and "typed into this shell" (#285): once you have set
it and successfully run any fleet command, `pnpm run fleet:control-host-install` writes that same address to
`/etc/a11ign/control-host` on the control plane — the same pattern `fleet:inventory-install` already uses
for `inventory.yml`. A later shell that never set the variable (a cron job, a fresh login) falls back to
that file instead of refusing. `A11Y_PVE_KEY` deliberately has no equivalent yet — see #285 for why that
stayed its own decision rather than being folded in here.

## It is not self-contained

The package reaches `packages/worker-fleet`, `packages/lab`, the core's `scripts/` and `guards` by relative path, so it is **laid** at `packages/control` in a checkout of `a11ign/a11ign`: on the
control plane (`/root/a11y-witness/packages/control`) and in CI. Every `packages/control/...` its code and tests name is that laid path, and it does not move with this repository's layout. CI
(`.github/workflows/ci.yml`) lays it over a checkout of the core at the commit in `CORE_REF` and runs the core's eslint, tsc and rstest config on it. To do the same by hand:

```bash
git clone https://github.com/a11ign/a11ign core && git -C core checkout <CORE_REF>
rm -rf core/packages/control && mkdir core/packages/control
cp -R src ansible layers.json CLAUDE.md README.md core/packages/control/
jq 'del(.version, .scripts, .devDependencies, .packageManager, .engines)' package.json > core/packages/control/package.json
printf '{ "extends": "./tsconfig.json", "include": ["packages/control/src/**/*.ts"] }\n' > core/tsconfig.control.json
cd core && pnpm install --frozen-lockfile
pnpm exec eslint packages/control && pnpm exec tsc --noEmit -p tsconfig.control.json
pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include "packages/control/**/*.test.ts"
```

Bumping `CORE_REF` is a pull request: the only way the core's changes reach this repository. `pnpm test` here runs only this repository's own checks (`scripts/`), and `pnpm run layout-check` is
`@a11ign/toolchain`'s check that the package stays at the root (one README, one manifest, no workspace file).

`main` takes pull requests only, each with one approving review, through the merge queue.

## Releasing

A change that should be released carries a changeset (`pnpm exec changeset`); **merging it is the release**. The changeset names `@a11ign/control`, which carries the version and the `CHANGELOG.md`.
`.github/workflows/release.yml` calls a11ign/toolchain's shared per-merge workflow (`kind: tag`), which cuts the tag
`v<version>` and a GitHub Release carrying the CHANGELOG entry: no registry, no token. A consumer pins a tag. **The first tag, `v0.1.0`, is cut by hand**, once,
on the merge of the pull request that added the workflow, because the workflow reads what the last tag consumed and so needs one.
