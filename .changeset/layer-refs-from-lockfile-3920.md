---
"@a11ign/control": patch
---

`lab:job --qualify-sha` supplies `layer_refs` itself (a11ign/a11ign #3920): each layer with its own repository is pinned at the commit its tag names on its remote, the tag being the one the sha's own `pnpm-lock.yaml` pins, and a tag the remote lacks is a refusal naming the layer, the tag and the remote before anything is posted. And `lab-layer-checkouts.yml` no longer refuses, before the install that lays it, a layer the pull has just removed.
