#!/usr/bin/python
# -*- coding: utf-8 -*-

# Documentation for the PowerShell module of the same name. Ansible requires the pair: the .ps1 is the
# implementation, this is what `ansible-doc` reads and what the argument spec is validated against.

from __future__ import absolute_import, division, print_function
__metaclass__ = type

DOCUMENTATION = r"""
module: a11y_nvda_updates
short_description: Turn NVDA's own update checks off across an install, and prove it took
description:
- NVDA checks for a new release at startup and its add-on store updates add-ons by itself. Either would move the screen reader that the capture cache
  keys on, on one box and not the others.
- Sets C([update] autoCheck = False), C([update] startupNotification = False) and C([addonStore] automaticUpdates = disabled) in every nvda.ini under
  the install, and re-reads them. A key that is absent is added, because NVDA's default for C(autoCheck) is True.
- guidepup's bundled config already ships these values, so this mostly proves the setting. It is idempotent and meant to run after every install.
options:
  path:
    description:
    - Root of the NVDA install to patch. Every nvda.ini beneath it is considered.
    type: path
    required: true
author:
- a11ign
"""

EXAMPLES = r"""
- name: NVDA cannot update itself
  a11y.worker.a11y_nvda_updates:
    path: C:\\Users\\witness\\AppData\\Local\\guidepup\\nvda
"""

RETURN = r"""
patched:
  description: The nvda.ini files this run changed.
  returned: always
  type: list
examined:
  description: How many nvda.ini files were found. Zero is a failure, not a no-op.
  returned: always
  type: int
"""
