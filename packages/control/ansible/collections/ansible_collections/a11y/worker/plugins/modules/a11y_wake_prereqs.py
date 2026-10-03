#!/usr/bin/python
# -*- coding: utf-8 -*-

# Documentation for the PowerShell module of the same name. Ansible requires the pair: the .ps1 is the
# implementation, this is what `ansible-doc` reads and what the argument spec is validated against.

from __future__ import absolute_import, division, print_function
__metaclass__ = type

DOCUMENTATION = r"""
module: a11y_wake_prereqs
short_description: Read, and where it can, repair the firmware and IP prerequisites of Wake-on-LAN
description:
- Reads the firmware Wake-on-LAN setting through Lenovo_BiosSetting where the machine is a Lenovo. A value of
  Disabled is repaired (Lenovo_SetBiosSetting then Lenovo_SaveBiosSettings) or fails by name. Any other value
  is left alone, so a working Automatic is never rewritten to Primary.
- A machine that is not a Lenovo, or whose WMI classes are absent, says so in firmware_status and is never
  reported as ok for a setting that was not read.
- Reads the adapter's IPv4 configuration. An address DHCP did not hand out (a static address, or the
  link-local one a failed lease produces) is reported by name and removed, the interface is returned to DHCP,
  and the adapter is read again so that ok means it was read clean.
- Fails when no physical adapter is Up, rather than reporting ok having read nothing.
options:
  interface:
    description:
    - Adapter name or wildcard to read.
    type: str
    default: '*'
  firmware_wol_value:
    description:
    - The value written when firmware Wake-on-LAN reads Disabled. Automatic is the value proved to wake a box.
    type: str
    default: Automatic
author:
- a11ign
"""

EXAMPLES = r"""
- name: Read the wake prerequisites this play cannot see
  a11y.worker.a11y_wake_prereqs:
"""

RETURN = r"""
repaired:
  description: Everything found wrong and repaired this run, as sentences naming the adapter.
  returned: always
  type: list
firmware_status:
  description: read, not-read (not a Lenovo) or unreadable (a Lenovo with no WMI class or item).
  returned: always
  type: str
firmware_wake_on_lan:
  description: The firmware value, when firmware_status is read.
  returned: always
  type: str
firmware_reason:
  description: Why the firmware was not read, when firmware_status is not read.
  returned: always
  type: str
failures:
  description: Everything that did not verify, as sentences naming the box.
  returned: always
  type: list
"""
