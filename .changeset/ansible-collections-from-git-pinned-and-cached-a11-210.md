---
"@a11ign/control": patch
---

The Ansible collections install from their GitHub repositories at exact release tags, not from Galaxy (A11-210). Galaxy's artifact downloads returned 500 on 2026-10-24 and stopped every pull request's `ansible` job. `ansible/requirements.yml` lists each collection as `type: git` at the tag its old `>=` range resolved to that day (`ansible.windows` 3.9.0, which installs as 3.9.1; `community.windows` 3.3.0; `community.general` 13.5.0; `ansible.posix` 2.2.2), with `community.library_inventory_filtering_v1` 1.1.5, which `community.general` depends on, so the install asks Galaxy for nothing. CI installs through one composite action that caches `~/.ansible/collections` on the file's hash, installs only on a miss and cannot reach Galaxy; `ansible-collections-cache.yml` saves that cache on `main`. `src/requirements-from-git.test.ts` holds the file to git sources and exact tags.
