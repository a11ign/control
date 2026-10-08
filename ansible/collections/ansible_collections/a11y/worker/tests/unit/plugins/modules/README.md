# Coverage of the six custom PowerShell modules

architecture-audit.md §7.2: "six custom modules (811 lines of PowerShell) have no test." Six honest
answers, per module, rather than four tests and two silences.

Every module opens with `$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)`, which cannot run
off Windows at all: `Ansible.Basic.cs` (ansible-core's own C# implementation of `AnsibleModule`, the thing
Ansible's exec wrapper injects at runtime) references `System.Web.Script.Serialization`, a .NET Framework
assembly with no .NET Core equivalent. Verified by trying: `Add-Type -Path Ansible.Basic.cs` under `pwsh`
on macOS fails with `CS0234: The type or namespace name 'Script' does not exist in the namespace
'System.Web'`. So no module file can be dot-sourced whole here — what follows is which PART of each one
can be, honestly assessed per module rather than assumed either way.

| module | verdict | why |
|---|---|---|
| `a11y_nvda.ps1` | **covered** — `a11y_nvda.Tests.ps1`, 6 tests | `Get-NvdaState` already stood alone, no `$module` reference, before this unit touched anything |
| `a11y_power_timeouts.ps1` | **covered** — `a11y_power_timeouts.Tests.ps1`, 4 tests | `Get-AcTimeout` already stood alone; `powercfg.exe` is shadowed with a stub function so Pester's `Mock` has something to intercept, since the real executable does not exist on this host at all |
| `a11y_speech_viewer.ps1` | **covered** — `a11y_speech_viewer.Tests.ps1`, 9 tests, after a small refactor | The patch loop and the re-read were inline, wrapped in `Set-SpeechViewerState` / `Get-SpeechViewerStillOnCount` (module diff below). Both are pure file I/O — no Windows-only cmdlet, no registry, no external process — so this needed separating the logic, not a real Windows box |
| `a11y_defender.ps1` | **not coverable off Windows** | Every branch worth testing depends on `Get-MpComputerStatus` / `Set-MpPreference`, Windows Defender cmdlets with no equivalent on macOS or Linux and nothing to shadow them against — a fake return value would be asserting against a guess at Defender's real shape, not the module. Fixed instead: PSScriptAnalyzer's one real finding across all six files was an empty `catch {}` here (`PSAvoidUsingEmptyCatchBlock`) that swallowed the ACTUAL reason `Get-MpComputerStatus` failed, so a permissions or WMI fault would report identically to "Defender genuinely absent". Now recorded as `status_error` in the result rather than thrown away — additive, not a behaviour change, since nothing here can be verified against a real failure off Windows |
| `a11y_nic_power.ps1` | **not coverable off Windows** | `Get-NetAdapter` / `Get-NetAdapterPowerManagement` / `Set-NetAdapterPowerManagement` are part of the Windows-only NetAdapter module, and the decision logic is interleaved with them per-adapter (read state, act, verify) rather than separated the way `Get-NvdaState` or `Get-AcTimeout` already were — extracting it now, with no Windows box to check the refactor against, would be added risk to fleet-critical code for unverifiable benefit |
| `a11y_onedrive.ps1` | **not coverable off Windows** | Every action reads or writes the real Windows registry (`HKCU:\...`), a real process (`Get-Process OneDrive`), or launches a real uninstaller — none of which exist to fake meaningfully on macOS. Same reasoning as `a11y_nic_power.ps1`: no already-isolated pure function to extract, and refactoring blind is the risk this repo's own culture warns against |

## Running

```bash
brew install powershell          # provides pwsh; not installed by default on macOS
pwsh -Command 'Install-Module Pester -RequiredVersion 5.7.1 -Force -Scope CurrentUser -SkipPublisherCheck'
pwsh -Command 'Import-Module Pester -RequiredVersion 5.7.1 -Force; Invoke-Pester -Path packages/control/ansible/collections/ansible_collections/a11y/worker/tests -Output Detailed'
```

Pester 6.1.0 (the version `Install-Module Pester` resolves to by default at the time of writing) hits a
[known issue](https://github.com/pester/Pester/issues/2669) — "a 'break' or 'continue' statement with a
label that does not match any enclosing loop escaped from your code" — that aborts a run using this file's
own `BeforeAll` + dynamically-built-scriptblock pattern. 5.7.1 does not have it. Pin the version until that
issue closes; do not assume the newest Pester is the right one to install.

## `TestHelpers.psm1` — why these tests dot-source the AST, not a copy

Several of the six modules already separated "read the world" from "decide, using `AnsibleModule`" for
reasons that had nothing to do with testing (`a11y_nvda.ps1`'s `Get-NvdaState`, `a11y_power_timeouts.ps1`'s
`Get-AcTimeout`). `Get-ModuleFunctionScriptBlock` parses the real `.ps1` file's AST and returns the named
function's own `Extent.Text` as a scriptblock, which the caller then dot-sources itself. Two things about
that shape are load-bearing, not stylistic:

- **The caller dot-sources it, not the helper.** A `.` inside a function only defines things in that
  function's own scope, which disappears the moment it returns — proven by mutation: the first version of
  this helper dot-sourced internally, and every test using it "passed" by silently finding nothing (a
  missing command reads as a thrown exception to `Should -Throw`, and none of these tests used that
  matcher, so they were actually failing with `CommandNotFoundException` and being read as green).
- **The function's text comes from the file being tested, not a hand-typed restatement of it.** A copy
  drifts from the original the way this whole repo's "a fact stated twice" catalogue describes, and a test
  built against a paraphrase proves the paraphrase, never the shipped code.

## The stamp — investigated, not changed here

docs/backlog.md's architecture-audit table already argues `provisionRevision` should hash five more
`a11y.worker` modules the way it hashes `a11y_speech_viewer.ps1`, on the grounds that each "reconciles
real environment state the way the Speech Viewer module does." Reading all six for this unit surfaces a
distinction that argument does not draw, worth recording rather than acting on unilaterally:

- **`a11y_nvda.ps1` and `a11y_onedrive.ps1` change what a capture can OBSERVE.** The first installs the
  exact NVDA build that produces every announcement; a threshold loosened here lets a corrupted install
  through silently. The second's own header states its mechanism outright — "a notification that steals
  focus mid-capture corrupts the evidence... one that merely sits over the page does it silently" — which
  is the identical shape `a11y_speech_viewer.ps1` was added for.
- **`a11y_defender.ps1`, `a11y_nic_power.ps1` and `a11y_power_timeouts.ps1` change whether the box stays
  REACHABLE, not what NVDA or Edge produce.** None of the three touches NVDA, Edge or anything a
  transcript can carry — they affect availability and performance, the same category the stamp's own file
  already excludes the ten role task files from ("change... for reasons that never reach a capture").

So the case for the first two looks as strong as Speech Viewer's; the case for the other three is closer
to the excluded task files than to it. This is a judgement call, not a fact this file can settle by
running anything, and `provisionRevision` moving is a full-fleet recapture — deliberately left for the
person scheduling that, with a full recapture already running at protocol 15 as this was written. No
change to `stamp-provision-revision.ps1` is included in this branch.
