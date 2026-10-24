#!powershell

# Turn NVDA's own update checks off, across every nvda.ini in an install, and prove it took (A11-205).
#
# NVDA checks for a new release at startup and offers it, and its add-on store updates add-ons by itself. Either would move a screen reader the
# whole capture cache keys on (`screenReaderVersion`), on one box and not the others. The keys are `[update] autoCheck`, `[update] startupNotification`
# and `[addonStore] automaticUpdates` (the ticket words the first as `autoCheckForUpdates`; the file says `autoCheck`, read off a live nvda.ini).
#
# guidepup's bundled config already ships these values, so this mostly PROVES the setting rather than changing it; a reinstall or a different guidepup
# could reset it, which is why it is idempotent and runs after every NVDA install. A module rather than inline script so that `--check` can say what it
# WOULD do, and so a run reports the files it changed.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        path = @{ type = 'path'; required = $true }
    }
    supports_check_mode = $true
}

# What every nvda.ini must say. Section, key, value: the file's own spelling. A key that is ABSENT is not off: NVDA's default for `autoCheck` is True.
function Get-NvdaUpdateSettings {
    return @(
        @{ section = 'update'; key = 'autoCheck'; value = 'False' },
        @{ section = 'update'; key = 'startupNotification'; value = 'False' },
        @{ section = 'addonStore'; key = 'automaticUpdates'; value = 'disabled' }
    )
}

# One `key = value` in one `[section]` of an ini's text: replaced where it is, added under its section where it is not, and the section added at the end where
# that is missing too. Text in, text out, so the decision is testable off Windows. Other sections, comments and line endings are left as they were.
function Set-IniValue([string]$Text, [string]$Section, [string]$Key, [string]$Value) {
    $newline = if ($Text -match "`r`n") { "`r`n" } else { "`n" }
    $lines = [System.Collections.Generic.List[string]]::new()
    if ($Text.Length -gt 0) { foreach ($line in ($Text -split "`r?`n")) { $lines.Add($line) } }
    $header = $lines.FindIndex({ param($l) $l -match ('^\[' + [regex]::Escape($Section) + '\]\s*$') })
    if ($header -lt 0) {
        while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
        $lines.Add("[$Section]")
        $lines.Add("$Key = $Value")
        return ($lines -join $newline) + $newline
    }
    $end = $lines.Count
    for ($i = $header + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\[') { $end = $i; break }
    }
    for ($i = $header + 1; $i -lt $end; $i++) {
        if ($lines[$i] -match ('^(\s*)' + [regex]::Escape($Key) + '\s*=\s*(.*?)\s*$')) {
            # A line that already says it is left exactly as it is, indentation included (guidepup's ini is tab-indented); one that does not keeps its indentation.
            if ($Matches[2] -ne $Value) { $lines[$i] = "$($Matches[1])$Key = $Value" }
            return ($lines -join $newline)
        }
    }
    $lines.Insert($header + 1, "$Key = $Value")
    return ($lines -join $newline)
}

# The value of `key` in `[section]`, or $null. Only the section's own lines are read: a same-named key in another section is not this one.
function Get-IniValue([string]$Text, [string]$Section, [string]$Key) {
    $inside = $false
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\[([^\[\]]+)\]\s*$') { $inside = ($Matches[1] -eq $Section); continue }
        if ($line -match '^\[') { $inside = $false; continue }
        if ($inside -and $line -match ('^\s*' + [regex]::Escape($Key) + '\s*=\s*(.*?)\s*$')) { return $Matches[1] }
    }
    return $null
}

# Every nvda.ini under $root that does not already say what we want, rewritten in place unless $checkMode. Returns @{ examined; patched } rather than
# writing to $module.Result, so the decision and the reporting stay two facts.
function Set-NvdaUpdateState($root, $checkMode) {
    $inis = @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'nvda.ini' -ErrorAction SilentlyContinue)
    $patched = [System.Collections.Generic.List[string]]::new()
    foreach ($ini in $inis) {
        $body = Get-Content -LiteralPath $ini.FullName -Raw
        if ($null -eq $body) { $body = '' }
        $new = $body
        foreach ($setting in (Get-NvdaUpdateSettings)) {
            $new = Set-IniValue $new $setting.section $setting.key $setting.value
        }
        if ($new -ne $body) {
            $patched.Add($ini.FullName)
            if (-not $checkMode) { Set-Content -LiteralPath $ini.FullName -Value $new -NoNewline }
        }
    }
    return @{ examined = $inis.Count; patched = $patched.ToArray() }
}

# The re-read half: every `file: section.key is 'value', wanted 'value'` that is not as wanted, read back from disk. Empty means every file says what we want.
function Get-NvdaUpdatesStillOn($root) {
    $wrong = [System.Collections.Generic.List[string]]::new()
    foreach ($ini in @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'nvda.ini' -ErrorAction SilentlyContinue)) {
        $body = Get-Content -LiteralPath $ini.FullName -Raw
        if ($null -eq $body) { $body = '' }
        foreach ($setting in (Get-NvdaUpdateSettings)) {
            $have = Get-IniValue $body $setting.section $setting.key
            if ($have -ne $setting.value) {
                $wrong.Add("$($ini.FullName): [$($setting.section)] $($setting.key) is '$have', wanted '$($setting.value)'")
            }
        }
    }
    return $wrong.ToArray()
}

$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$root = $module.Params.path
if (-not (Test-Path -LiteralPath $root)) {
    $module.FailJson("no NVDA install at $root")
}

$state = Set-NvdaUpdateState $root $module.CheckMode
# Zero ini files is not "nothing to do": we were pointed at something that is not an NVDA install, and ok would be success having examined nothing.
if ($state.examined -eq 0) {
    $module.FailJson("no nvda.ini under $root -- this does not look like an NVDA install")
}

$module.Result.changed = $state.patched.Count -gt 0
$module.Result.patched = $state.patched
$module.Result.examined = $state.examined

if ($module.Diff) {
    $module.Diff.before = @{ files = $state.patched }
    $module.Diff.after = @{ files = $state.patched; settings = (Get-NvdaUpdateSettings | ForEach-Object { "[$($_.section)] $($_.key) = $($_.value)" }) }
}

# Verified by RE-READING, never by assuming the write worked. Nothing was written in check mode, so there is nothing to verify there.
if (-not $module.CheckMode) {
    $wrong = @(Get-NvdaUpdatesStillOn $root)
    if ($wrong.Count -gt 0) {
        $module.FailJson("NVDA can still update itself after patching: " + ($wrong -join '; '))
    }
}

$module.ExitJson()
