#!powershell

# Turn NVDA's Speech Viewer off, across every nvda.ini in an install, and prove it took.
#
# This is the highest-value setting on a capture worker and the one that fails most quietly.
# guidepup's bundled config ships the Speech Viewer ON. That window's focus event is ANNOUNCED, so it
# lands in the spokenPhraseLog delta captured right after activating a control: every interaction probe
# returns "NVDA Speech Viewer" instead of the page's response, which makes an accessible page and an
# inaccessible one INDISTINGUISHABLE.
#
# It fails silently by construction -- capture-check asserts that the probe fired, not what it heard --
# so the re-read at the end is not belt and braces, it is the only thing that can catch it.
#
# Reinstalling NVDA resets this, which is why it is idempotent and run after every install rather than
# once. A module rather than inline script so that `--check` can say what it WOULD do without doing it,
# and so a run reports a diff of the actual lines it changed.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        path    = @{ type = 'path'; required = $true }
        enabled = @{ type = 'bool'; default = $false }
    }
    supports_check_mode = $true
}
# Every nvda.ini under $root whose showSpeechViewerAtStartup line does not already say what we want,
# rewritten in place unless $checkMode. Pure file I/O, no AnsibleModule reference, so this is the seam a
# test uses off Windows -- see tests/unit/plugins/modules/TestHelpers.psm1 for why the rest of this file
# cannot run there at all.
#
# Returns @{ examined; patched } rather than writing to $module.Result directly, so the decision (what
# changed) and the reporting (how AnsibleModule renders it) stay two separate facts -- exactly the split
# `docs/proving-a-gate.md` names for the same reason everywhere else in this repo.
function Set-SpeechViewerState($root, $enabled, $checkMode) {
    $want = if ($enabled) { 'True' } else { 'False' }
    $unwanted = if ($enabled) { 'False' } else { 'True' }

    $inis = @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'nvda.ini' -ErrorAction SilentlyContinue)
    $patched = [System.Collections.Generic.List[string]]::new()
    foreach ($ini in $inis) {
        $body = Get-Content -LiteralPath $ini.FullName -Raw
        $new = $body -replace "showSpeechViewerAtStartup = $unwanted", "showSpeechViewerAtStartup = $want"
        if ($new -ne $body) {
            $patched.Add($ini.FullName)
            if (-not $checkMode) {
                Set-Content -LiteralPath $ini.FullName -Value $new -NoNewline
            }
        }
    }
    return @{ examined = $inis.Count; patched = $patched.ToArray() }
}

# The re-read half: how many nvda.ini files under $root still have the Speech Viewer ON. Separate from
# the patch above because it runs unconditionally different -- only when turning it OFF, and never in
# check mode, since nothing was written to re-read.
function Get-SpeechViewerStillOnCount($root) {
    return @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'nvda.ini' -ErrorAction SilentlyContinue |
        Select-String -Pattern 'showSpeechViewerAtStartup = True').Count
}

$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$root = $module.Params.path
if (-not (Test-Path -LiteralPath $root)) {
    $module.FailJson("no NVDA install at $root")
}

$state = Set-SpeechViewerState $root $module.Params.enabled $module.CheckMode
# Zero ini files is not "nothing to do" -- it means we were pointed at something that is not an NVDA
# install, and reporting ok would be reporting success having examined nothing.
if ($state.examined -eq 0) {
    $module.FailJson("no nvda.ini under $root -- this does not look like an NVDA install")
}

$module.Result.changed = $state.patched.Count -gt 0
$module.Result.patched = $state.patched
$module.Result.examined = $state.examined

# The diff is the point of doing this as a module: it says WHICH files moved, not just that something did.
if ($module.Diff) {
    $unwanted = if ($module.Params.enabled) { 'False' } else { 'True' }
    $want = if ($module.Params.enabled) { 'True' } else { 'False' }
    $module.Diff.before = @{ showSpeechViewerAtStartup = $unwanted; files = $state.patched }
    $module.Diff.after = @{ showSpeechViewerAtStartup = $want; files = $state.patched }
}

# Verified by RE-READING, never by assuming the replace worked. In check mode there is nothing to verify
# because nothing was written, and claiming otherwise would be the check-mode equivalent of a guard that
# reports success having examined nothing.
if (-not $module.CheckMode -and -not $module.Params.enabled) {
    $stillOn = Get-SpeechViewerStillOnCount $root
    if ($stillOn -gt 0) {
        $module.FailJson("Speech Viewer is STILL enabled in $stillOn file(s) after patching; " +
            "interaction probes would be unusable and every one would look like a page failure.")
    }
}

$module.ExitJson()
