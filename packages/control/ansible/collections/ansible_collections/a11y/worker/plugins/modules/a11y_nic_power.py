#!/usr/bin/python
# -*- coding: utf-8 -*-

# Documentation for the PowerShell module of the same name. Ansible requires the pair: the .ps1 is the
# implementation, this is what `ansible-doc` reads and what the argument spec is validated against.
#
# Generated with a YAML dumper rather than hand-formatted, because hand-formatting produced `default: *`
# -- which YAML reads as an ALIAS -- and a description containing ": ", which it reads as a mapping.
# Both failed as "missing documentation", which points at the wrong thing entirely.

from __future__ import absolute_import, division, print_function
__metaclass__ = type

DOCUMENTATION = r"""
module: a11y_nic_power
short_description: Stop Windows powering the network adapter down
description:
- The second of two mechanisms that make a worker vanish; fixing only the sleep timers leaves the fault
  intermittent. Selective suspend powers the adapter down while the OS stays up.
- Uses Set-NetAdapterPowerManagement where the SKU has it, and falls back to the registry value that cmdlet
  writes (PnPCapabilities 24, disabling both power-down and wake-armed).
- Fails when no physical adapter is Up, rather than reporting ok having adjusted nothing - this module
  exists because the network disappears.
- 'Sets two INDEPENDENT things: the adapter is not powered down while the machine runs, and it may still
  wake the machine. Conflating them is how Wake-on-LAN gets silently disabled.'
- 'Arms the DEVICE as well (powercfg /deviceenablewake, Device Manager''s "Allow this device to wake the
  computer"), which is separate from the adapter property: Windows disarms Wake-on-LAN at every shutdown while
  it is unticked, whatever the adapter property says. Then READS IT BACK from powercfg /devicequery wake_armed.'
- 'Reads back, never writes, the NDIS keywords *WakeOnMagicPacket=1, *WakeOnPattern=0 and *EEE=0 (bespoke.yml
  sets them, because setting one re-initialises the adapter and drops the connection) and HibernateEnabled=0.'
- 'FAILS BY NAME, listing every problem it read, when the box cannot be woken. Reports wake-armed, UNPROVEN and
  never more: arming says Windows will honour a packet, and only a real power cycle says the box comes back.'
options:
  interface:
    description:
    - Adapter name or wildcard to adjust.
    type: str
    default: '*'
  wake_on_lan:
    description:
    - Whether the adapter may wake the machine with a magic packet.
    - On by default, because this fleet is meant to be POWERED DOWN between runs and woken by wake.yml.
    - The registry fallback used to write PnPCapabilities 24, which Microsoft documents as also preventing
      the adapter from waking the computer - so on a box without the cmdlet it would have made Wake-on-LAN
      impossible while reporting success. It writes 8 now.
    type: bool
    default: true
author:
- a11ign
"""

EXAMPLES = r"""
- name: Keep the NIC awake
  a11y.worker.a11y_nic_power:
"""

RETURN = r"""
adjusted:
  description: Adapters this run changed.
  returned: always
  type: list
via_registry:
  description: Adapters that needed the registry fallback because the cmdlet was absent.
  returned: always
  type: list
wake_failures:
  description: Every reason this box cannot be woken, as sentences naming the adapter. Empty when armed and verified.
  returned: always
  type: list
wake_proof:
  description: Always UNPROVEN. Provisioning cannot power a box off mid-play, so it never claims the cycle.
  returned: always
  type: str
wake_report:
  description: The one-line report for this worker.
  returned: always
  type: str
"""
