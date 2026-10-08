#!/usr/bin/python
# -*- coding: utf-8 -*-

# Documentation for the PowerShell module of the same name. Ansible requires the pair: the .ps1 is the
# implementation, this is what `ansible-doc` reads and what the argument spec is validated against.

from __future__ import absolute_import, division, print_function
__metaclass__ = type

DOCUMENTATION = r"""
module: a11y_boot_order
short_description: Read, and with enforce take network boot out of, the firmware boot order (Lenovo and HP)
description:
- Reads the firmware boot order by NAME from the box (Lenovo_BiosSetting on a Lenovo, HP_BIOSOrderedList in
  root\HP\InstrumentedBIOS on an HP) and says what it found. No setting name or value is typed in this
  repository; a setting it cannot find is unreadable, with the item names it did see.
- With enforce true, writes the box's own order with its network members taken out (removed on a Lenovo;
  marked C((Disabled)) in place on an HP, whose ordered list ignores a value that omits members), saves it,
  and reads the stored value back. A read-back that is not the target is a failure naming the box. With enforce false
  (the default) no setter is called.
- Reads Wake on LAN beside the boot order and never rewrites it. Lenovo's Automatic wake sequence starts with
  Network, so a result whose wake sequence cannot be shown to omit Network is order-set, never ok.
- Reads bcdedit /enum firmware as a second, cross-vendor reading and says whether a network entry remains
  addressable for a one-time BootNext. Entries are never deleted.
- The claim is the setting, not the behaviour. Nothing here boots a box with a PXE server answering.
options:
  enforce:
    description:
    - Write the order without its network members. Off by default, so provisioning reads and reports only.
    type: bool
    default: false
author:
- a11ign
"""

EXAMPLES = r"""
- name: Read the boot order (writes nothing)
  a11y.worker.a11y_boot_order:

- name: Take network boot out of the order, one worker first
  a11y.worker.a11y_boot_order:
    enforce: true
"""

RETURN = r"""
boot_status:
  description: >-
    ok or changed (the stored order omits Network and nothing is left unshown), order-set (it does, with a
    caveat in boot_reasons), needs-change (network is in the order and nothing was written), not-read (not a
    Lenovo or HP), unreadable (the class or item could not be read), or failed (a write refused, or a
    read-back that was not the target).
  returned: always
  type: str
boot_reasons:
  description: Why the status is not ok, as sentences.
  returned: always
  type: list
enforced:
  description: Whether enforcement was on for this run.
  returned: always
  type: bool
vendor:
  description: Lenovo, HP, or null for a box this module cannot speak for.
  returned: always
  type: str
manufacturer:
  description: Win32_ComputerSystem.Manufacturer as read.
  returned: always
  type: str
boot_setting:
  description: The name of the boot-order setting the box advertised, found by name.
  returned: always
  type: str
boot_order_before:
  description: The stored order as read before any write.
  returned: always
  type: list
boot_order_after:
  description: The stored order read back after a write (the same as before when nothing was written).
  returned: always
  type: list
boot_order_target:
  description: What enforce would write, or wrote.
  returned: always
  type: list
boot_items_seen:
  description: Every firmware item whose name suggests boot, so a miss can be diagnosed from the result.
  returned: always
  type: list
wake_on_lan:
  description: The Lenovo Wake on LAN value, read and never rewritten.
  returned: always
  type: str
wake_sequence:
  description: omits-network, includes-network or UNREAD.
  returned: always
  type: str
wake_sequence_reason:
  description: What the wake sequence verdict was read from.
  returned: always
  type: str
live_firmware_order:
  description: The UEFI entries bcdedit says the firmware will try, in order.
  returned: always
  type: list
network_entry_addressable:
  description: yes, no or UNREAD - whether a network firmware entry remains for a one-time BootNext.
  returned: always
  type: str
rebuild_path:
  description: The rebuild path after enforcement, as a sentence.
  returned: always
  type: str
"""
