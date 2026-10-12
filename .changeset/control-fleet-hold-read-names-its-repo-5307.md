---
"@a11ign/control": patch
---

The fleet-hold read now names `a11ign/a11ign`, where the rows live, instead of asking the checkout's own remote. From control's checkout that remote is `a11ign/control`, which has issues disabled, so every write play refused on the hold read before reaching the plane (a11ign/a11ign#5307). The remote-sync half of #5307 (`controlPlaneCheckout`) is NOT in this change: it needs the plane's `/root/control` checkout, which nothing provisions yet (a11ign/a11ign#5306).
