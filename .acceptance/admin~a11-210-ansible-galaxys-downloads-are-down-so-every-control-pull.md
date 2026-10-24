A11-210 (https://linear.app/a11ign/issue/A11-210/ansible-galaxys-downloads-are-down-so-every-control-pull-request-fails). Galaxy's artifact downloads were down on 2026-10-24, so every control pull request's `ansible` job failed.

What the change does: `ansible/requirements.yml` lists `ansible.windows`, `community.windows`, `community.general`, `ansible.posix` and `community.library_inventory_filtering_v1` (community.general's dependency) as `type: git`, from `github.com/ansible-collections`, at exact tags, each the version the old `>=` range resolved to that day. CI installs them through `.github/actions/ansible-collections`, which caches `~/.ansible/collections` on the file's hash, installs only on a miss, and points Galaxy at a closed loopback port. `ansible-collections-cache.yml` saves that cache on `main`.

Acceptance:

```bash
set -euo pipefail
T=$(mktemp -d); trap 'rm -rf "${T:?}"' EXIT
python3 -m venv "$T/venv" && "$T/venv/bin/pip" -q install ansible-core pyyaml
export HOME="$T/home" PATH="$T/venv/bin:$PATH"
mkdir -p "$HOME"
# Galaxy is unreachable: the install must not need it.
ANSIBLE_GALAXY_SERVER=http://127.0.0.1:9/ ansible-galaxy collection install -r ansible/requirements.yml -p ~/.ansible/collections
# Each collection installed at the version the old range resolved to.
ansible-galaxy collection list -p ~/.ansible/collections | grep -E '^(ansible\.windows +3\.9\.1|community\.windows +3\.3\.0|community\.general +13\.5\.0|community\.library_inventory_filtering_v1 +1\.1\.5|ansible\.posix +2\.2\.2) *$' | wc -l | grep -qx 5
# The job's own checks, over what was installed.
for p in ansible/*.yml; do case "$p" in ansible/inventory.example.yml|ansible/requirements.yml) continue;; esac
  ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook -i ansible/inventory.example.yml --syntax-check "$p" >/dev/null; done
(cd ansible && python3 check-modules.py && python3 check-lab-fetch-destination.py)
pnpm install --frozen-lockfile && pnpm test
```

**What the block shows:** the five collections install from git with Galaxy unreachable, at the pinned versions, and the playbooks still parse and match their modules' documentation. `pnpm test` runs `scripts/ci-composition.test.ts` (the cache key, no `restore-keys`, install only on a miss, the `main` workflow). `src/requirements-from-git.test.ts` (every entry `type: git`, an exact tag, no Galaxy source) runs in the `checks` job over the core's lay, because it parses with `yaml`, which this repository's own install does not hold.

**After merge:** the `ansible` job's log shows `ansible collections cache: HIT` once `ansible-collections-cache.yml` has run on `main`. Chairman session: control#132 re-runs green after merging main in.

Closes A11-210
