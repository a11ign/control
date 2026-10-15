Row a11ign/a11ign#5532: `deploy.yml`'s `a11y_repo_root` resolves to the control checkout, and its first task's import path exists beneath it.

Acceptance:

```bash
cd /home/agent/repos/control-wt-5532 && node --test src/deploy-repo-root.test.ts
```

Prints `pass 2`, `fail 0`. The test resolves `playbook_dir + <the expression in deploy.yml>` and requires it to be the directory holding `package.json`, and the `./src/layer-checkouts.ts` the task imports to exist beneath it. Before the change the expression resolved to `/` and the old import path did not exist, so both fail.

## What changed

- `ansible/deploy.yml`: `a11y_repo_root` is `playbook_dir/..`; the import is `./src/layer-checkouts.ts`.
- `src/deploy-repo-root.test.ts`: the pin.
- `.changeset/deploy-repo-root-5532.md`.

## Not done here

- No fleet command was run (the resource ban). The row's literal command (with `/opt/a11y-tsx`) cannot run on this host: the loader is absent; with plain node type-stripping the import now resolves and stops at "layer nvda-worker does not exist" (no layer checkout on this host), past the `ERR_MODULE_NOT_FOUND`.
- `reset-checkout.yml:216`, `collect-logs.yml:26`, `lab-log.yml:145`, `inventory-install.yml:88`, `roles/worker/tasks/bespoke.yml:243` carry the same `../../..`; outside this row's Region, not read for reach.
