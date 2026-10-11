---
"@a11ign/control": patch
---

The Edge-updater guard's record keeps the last re-enable (`lastReenabledAt`, `lastReenabled`) across clean runs, so a drift no longer vanishes at the next 15-minute run (a11ign#5048, part of #4405).
