---
"@a11ign/control": patch
---

`fleet:deploy --layer-ref` reaches the playbook on a control plane that holds a layer laid rather than cloned, and can pin a release whose commit is only a tag (a11ign/a11ign #4150, #4107's chain). A LAID layer (`.layer-ref` beside `src/`, no `.git`) is accepted when the commit its tag names on the layer's remote is the pin, and refused, naming the layer, the `.layer-ref` and the pin, when it is not; a path with neither shape still refuses. A CLONED layer's move now fetches tags (`git fetch --quiet --tags origin`), so a version commit that no branch holds is a commit the control plane has. The refusal no longer sends the operator to `bootstrap-control-plane.sh`, and the comment that said nothing lays on the control plane is corrected.
