#!/usr/bin/env python3
"""Render `lab-fetch.yml`'s REAL destination expression and check where it lands (a11ign/a11ign#5521).

    python3 check-lab-fetch-destination.py

The fetched artifact goes to `{{ playbook_dir }}/../runs/fetched/`. Each `../` is read by ANSIBLE, so a wrong count
is invisible to a text search: the old `../../../` was the core's root when control lived below it, and here it
climbs out of every checkout onto `/`, so a fetch that succeeded (`failed=0`) left the archive there.

This does not match the playbook's text. It takes the set_fact task out of `lab-fetch.yml` as written, runs it in a
probe playbook laid out like this checkout (`<root>/ansible/probe.yml`, so `playbook_dir` is what the real play sees),
and reads back the path Ansible produced. The probe is `hosts: localhost` with `connection: local`: it cannot reach
the lab, and it writes nothing (`set_fact` does not touch the disk).

A positive control runs the same probe on the expression as it was before the fix. If that is not refused, this
check cannot say no, and it fails.

It needs ansible-core, so it runs in the `ansible` job of ci.yml and is NOT part of `pnpm test`.
Exit 0 clean, 1 if the destination lands outside the expected place or the task cannot be found.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

PLAYBOOK = Path(__file__).resolve().parent / "lab-fetch.yml"
DESTINATION_TASK = "Name it after what it actually is"
SHOW_TASK = "show destination"

# (artifact, source path). The extension comes from the source, so one markdown and one json case cover the shape.
CASES = [("promoted-changeset", "runs/promoted-changeset.md"), ("candidate-json", "runs/candidate.json")]

# The expression as it was before a11ign#5521, which climbed three levels out of the checkout.
OLD_DESTINATION = (
    "{{ playbook_dir }}/../../../runs/fetched/{{ out | default('candidate') }}.{{ artifact"
    " }}{{ (lab_fetch_src | splitext)[1] | default('.json', true) }}"
)


def destination_task(task_name=DESTINATION_TASK):
    plays = yaml.safe_load(PLAYBOOK.read_text())
    found = [task for play in plays for task in (play.get("tasks") or []) if task.get("name") == task_name]
    if len(found) != 1:
        raise SystemExit(f"{PLAYBOOK.name}: expected one task named '{task_name}', found {len(found)}")
    return found[0]


def probe_play(task, artifact, source):
    return [{
        "hosts": "localhost",
        "connection": "local",
        "gather_facts": False,
        "vars": {"artifact": artifact, "lab_fetch_src": source},
        "tasks": [task, {"name": SHOW_TASK, "ansible.builtin.debug": {"msg": "{{ lab_fetch_dest }}"}}],
    }]


def landed_at(task, artifact, source, scratch):
    """The destination Ansible computes for `task`, with `playbook_dir` = <root>/ansible; also the root it was laid in."""
    root = Path(tempfile.mkdtemp(dir=scratch))
    (root / "ansible").mkdir()
    probe = root / "ansible" / "probe.yml"
    probe.write_text(yaml.safe_dump(probe_play(task, artifact, source)))
    env = {**os.environ, "ANSIBLE_STDOUT_CALLBACK": "json", "ANSIBLE_LOCALHOST_WARNING": "False"}
    result = subprocess.run(
        ["ansible-playbook", "-i", "localhost,", probe.name],
        cwd=probe.parent, env=env, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"the probe failed (exit {result.returncode}):\n{result.stderr}")
    for task_result in json.loads(result.stdout)["plays"][0]["tasks"]:
        if task_result["task"]["name"] == SHOW_TASK:
            return root, os.path.normpath(task_result["hosts"]["localhost"]["msg"])
    raise SystemExit("the probe printed no destination")


def expected_under(root, artifact, source):
    return os.path.normpath(root / "runs" / "fetched" / f"candidate.{artifact}{Path(source).suffix}")


def main():
    task = destination_task()
    problems = []
    with tempfile.TemporaryDirectory(prefix="lab-fetch-destination-") as scratch:
        for artifact, source in CASES:
            root, landed = landed_at(task, artifact, source, Path(scratch))
            want = expected_under(root, artifact, source)
            if landed != want:
                problems.append(f"{artifact}: landed at {landed}, expected {want}")
            else:
                print(f"ok: {artifact} -> {os.path.relpath(landed, root)}")

        artifact, source = CASES[0]
        old = {**task, "ansible.builtin.set_fact": {"lab_fetch_dest": OLD_DESTINATION}}
        root, landed = landed_at(old, artifact, source, Path(scratch))
        if landed == expected_under(root, artifact, source):
            problems.append("positive control: the old expression was NOT refused, so this check cannot say no")
        else:
            print(f"ok: the old expression is refused (lands at {landed})")

    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
