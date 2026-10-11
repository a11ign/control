---
"@a11ign/control": patch
---

`fleet-watch` records, at each hourly tick, which boxes were awake and which worked, and posts the fleet's use on #928 once per UTC day: captures per box and the share of awake box-ticks that did work (a11ign#5016, part of #4405). Under 20 observed ticks it says `unknown` rather than a share.
