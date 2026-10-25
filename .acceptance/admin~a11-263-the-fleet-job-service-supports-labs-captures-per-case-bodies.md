A11-263 (https://linear.app/a11ign/issue/A11-263/the-fleet-job-service-supports-labs-captures-per-case-bodies-same-box), step 2 of 4. The lab reaches the fleet job service, and the lab catalogue hands its capture jobs a label and boxes.

What the change does: `src/fleet-jobs/gate.ts` is the forced command for the lab's key: it runs `remote.ts` only in the form `controlPlaneTransport` sends and refuses everything else (exit 2). `ansible/fleet-jobs-lab-access.yml` makes the key on the lab, installs it on the control plane behind the gate, lays the `fleet` command on the lab, and reads back from the lab. `ansible/lab-job.yml` makes `label` a required parameter of every job that captures and gives those jobs `A11Y_FLEET_BOXES`, `A11Y_FLEET_LABEL` and `A11Y_FLEET_WAIT`. `lab:pipeline` takes `--label`, and a qualified `gate-stability` run with no label is booked as `qualify-<row>`. Lab's own clients move in steps 3 and 4.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
# The gate: the exact form runs (a submit, a tar, a quote inside an argument); a second command, another path or loader, an unquoted argument, an empty command are refused with exit 2, run as a real process too; and the play installs the key as restrict,command=<the gate>, makes it on the lab, reads only the public half, and reads back from the lab.
node --import tsx --test --test-concurrency=1 src/fleet-jobs/gate.test.ts
# The service is unchanged: its import rule holds with the gate beside it, and step 1's tests still pass.
node --import tsx --test --test-concurrency=1 src/fleet-jobs/*.test.ts src/fleet-leases/*.test.ts
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook --syntax-check -i localhost, ansible/fleet-jobs-lab-access.yml
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook --syntax-check -i localhost, ansible/lab-job.yml
pnpm typecheck
pnpm test
```

In the core's lay (`ci.yml` lays this repository into a checkout of a11ign/a11ign as `packages/control`, which has `yaml` and the toolchain these import), these also pass: `src/control-owned/lab-job.test.ts` (the `label` parameter is required on exactly the twelve jobs and the three variables are set on exactly those; a malformed label and a bad box are refused), `src/lab-job.test.ts` (a qualified run with no label is booked as `qualify-<row>`) and `src/lab-pipeline.test.ts` (`--label` reaches exactly the stages that take one).

**What the block shows:** the gate runs the one request `fleet` sends and nothing else; the play's text keeps the private key on the lab; every capture job requires a label and is given its boxes, label and wait.

**Live check, AFTER merge** (the chairman's session, from the agents host; the ticket's Decisions entry "The lab-access play is an after-merge check" (https://linear.app/a11ign/issue/A11-263/the-fleet-job-service-supports-labs-captures-per-case-bodies-same-box) moves it there, because the play needs this code on the control plane and the fleet is frozen). The play touches the control plane and the lab, and no fleet box. A pass is the play's last two tasks succeeding: the lab's `fleet lease list --json` answers JSON, and the gate refuses `id` with its own words.

```bash
set -euo pipefail
BRANCH=admin/a11-263-the-fleet-job-service-supports-labs-captures-per-case-bodies
pnpm run fleet:jobs-install -- -e fleet_jobs_ref="$BRANCH"        # the service, and so gate.ts, on the plane
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook ansible/fleet-jobs-lab-access.yml -e fleet_jobs_ref="$BRANCH"
# expect: "the lab reads the plane's leases: N held" and "the gate refused `id`: refused: this key runs only the fleet job service's remote half ..."
# after the merge the branch above is `main`: run fleet:jobs-install and the lab-access play with no -e (the default ref is main), and quote the two read-backs on the ticket
```

This step changes nothing a lab client reads yet: the variables are read from step 3. It does make `label` required of the jobs above, so a launch of one (including a lab gate dispatch) needs `-e label=<ticket key>` from now on.
