Row a11ign/a11ign#5426. **Run location (read, 2026-10-13):** `lab-job.ts` and `lab-watch.ts` run on the control plane, whose checkout is control's own repository (`/root/control`, a11ign/a11ign#5310). `lab-job.ts` set its `ansible-playbook` cwd from `new URL("../../../", import.meta.url)`, which is `/` there (it is the core root only in a laid `packages/control/src`), and both files named `packages/control/ansible/...` relative to it, so on the plane every path missed. Not measured on the plane itself (no access); derived from the code and the layout. Both now resolve `ansible/` one directory up from their own file, valid in either layout, and `lab-job` runs with `ansible/` as cwd, as `fleet-playbook.ts` does.

Outside-Region: src/lab-job.test.ts, src/lab-watch.test.ts — they pinned the old string; they now pin the file-relative path and assert it exists (positive control).

Acceptance: `pnpm exec node --test src/lab-job.test.ts src/lab-watch.test.ts src/lab-jobs-run-pnpm.test.ts`

**As run (measured):** tests 100, pass 100, fail 0. `tsc --noEmit` clean. (`yaml` and `@a11ign/*` were linked in from the core's `node_modules` to resolve, an environment fact of this worktree.)

Mutation: `CATALOGUE` put back to `packages/control/ansible/lab-job.yml` makes the `#1670` argv test fail; restored byte-identical (`cp` before and after).

Closes a11ign/a11ign#5426
