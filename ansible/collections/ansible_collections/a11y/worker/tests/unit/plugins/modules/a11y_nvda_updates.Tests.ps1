# Covers Set-IniValue, Get-IniValue, Set-NvdaUpdateState and Get-NvdaUpdatesStillOn, extracted from a11y_nvda_updates.ps1 so they can be tested off
# Windows: they are pure text and file I/O with no AnsibleModule reference. See TestHelpers.psm1 for why the rest of the module cannot run here.
#
# The module's reason is A11-205: NVDA that checks for updates, or an add-on store that updates add-ons, moves the screen reader the capture cache keys on.
# The keys are `[update] autoCheck`, `[update] startupNotification` and `[addonStore] automaticUpdates`. A key that is ABSENT is not off (NVDA's default for
# autoCheck is True), so the re-read treats absent as wrong.
BeforeAll {
    Import-Module "$PSScriptRoot/TestHelpers.psm1" -Force
    $ModulePath = "$PSScriptRoot/../../../../plugins/modules/a11y_nvda_updates.ps1"
    foreach ($name in 'Get-NvdaUpdateSettings', 'Set-IniValue', 'Get-IniValue', 'Set-NvdaUpdateState', 'Get-NvdaUpdatesStillOn') {
        . (Get-ModuleFunctionScriptBlock -Path $ModulePath -Name $name)
    }
}

Describe 'Set-IniValue (a11y_nvda_updates.ps1)' {
    It 'replaces a key where it is, leaving every other line alone' {
        $text = "[general]`nlanguage = en`n[update]`nautoCheck = True`nallowUsageStats = False`n"
        $new = Set-IniValue $text 'update' 'autoCheck' 'False'
        $new | Should -Be "[general]`nlanguage = en`n[update]`nautoCheck = False`nallowUsageStats = False`n"
    }

    It 'adds a missing key under its own section, not at the end of the file' {
        $text = "[update]`nallowUsageStats = False`n[speech]`nsynth = oneCore`n"
        $new = Set-IniValue $text 'update' 'autoCheck' 'False'
        (Get-IniValue $new 'update' 'autoCheck') | Should -Be 'False'
        (Get-IniValue $new 'speech' 'autoCheck') | Should -BeNullOrEmpty
    }

    It 'adds the section when it is missing too' {
        $new = Set-IniValue "[general]`nlanguage = en`n" 'addonStore' 'automaticUpdates' 'disabled'
        (Get-IniValue $new 'addonStore' 'automaticUpdates') | Should -Be 'disabled'
        (Get-IniValue $new 'general' 'language') | Should -Be 'en'
    }

    It 'does not touch a same-named key in another section' {
        $text = "[speech]`nautoCheck = True`n[update]`nautoCheck = True`n"
        $new = Set-IniValue $text 'update' 'autoCheck' 'False'
        (Get-IniValue $new 'speech' 'autoCheck') | Should -Be 'True'
        (Get-IniValue $new 'update' 'autoCheck') | Should -Be 'False'
    }

    It 'keeps CRLF line endings' {
        $new = Set-IniValue "[update]`r`nautoCheck = True`r`n" 'update' 'autoCheck' 'False'
        $new | Should -Be "[update]`r`nautoCheck = False`r`n"
    }

    It 'reads the shape guidepup ships and a live worker holds: keys indented with a TAB, already off, so nothing is patched' {
        # Read off a11y-worker-2 on 2026-10-24: both nvda.ini files carry exactly these lines, tab-indented.
        $text = "[update]`n`tautoCheck = False`n`tstartupNotification = False`n[addonStore]`n`tautomaticUpdates = disabled`n"
        (Get-IniValue $text 'update' 'autoCheck') | Should -Be 'False'
        (Get-IniValue $text 'addonStore' 'automaticUpdates') | Should -Be 'disabled'
        $new = $text
        foreach ($setting in (Get-NvdaUpdateSettings)) { $new = Set-IniValue $new $setting.section $setting.key $setting.value }
        $new | Should -Be $text
    }

    It 'is a no-op on a value that is already right' {
        $text = "[update]`nautoCheck = False`n"
        (Set-IniValue $text 'update' 'autoCheck' 'False') | Should -Be $text
    }
}

Describe 'Set-NvdaUpdateState and Get-NvdaUpdatesStillOn (a11y_nvda_updates.ps1)' {
    BeforeEach {
        $script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Root | Out-Null
    }
    AfterEach {
        Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
    }

    BeforeAll {
        function script:New-NvdaIni([string]$RelativeDir, [string]$Body) {
            $dir = Join-Path $script:Root $RelativeDir
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $path = Join-Path $dir 'nvda.ini'
            Set-Content -LiteralPath $path -Value $Body -NoNewline
            return $path
        }
        $script:Frozen = "[update]`nautoCheck = False`nstartupNotification = False`n[addonStore]`nautomaticUpdates = disabled`n"
    }

    It 'turns all three settings off in a file that has them on' {
        $ini = New-NvdaIni 'nvda' "[update]`nautoCheck = True`nstartupNotification = True`n[addonStore]`nautomaticUpdates = enabled`n"
        $result = Set-NvdaUpdateState $script:Root $false
        $result.patched | Should -Contain $ini
        Get-NvdaUpdatesStillOn $script:Root | Should -BeNullOrEmpty
    }

    It 'adds the settings to a file that says nothing about them, because absent is not off' {
        $ini = New-NvdaIni 'nvda' "[general]`nlanguage = en`n"
        Get-NvdaUpdatesStillOn $script:Root | Should -Not -BeNullOrEmpty
        $result = Set-NvdaUpdateState $script:Root $false
        $result.patched | Should -Contain $ini
        Get-NvdaUpdatesStillOn $script:Root | Should -BeNullOrEmpty
    }

    It 'leaves a file that is already right untouched, and does not name it' {
        $ini = New-NvdaIni 'nvda' $script:Frozen
        $result = Set-NvdaUpdateState $script:Root $false
        $result.patched | Should -BeNullOrEmpty
        (Get-Content -LiteralPath $ini -Raw) | Should -Be $script:Frozen
    }

    It 'patches EVERY nvda.ini under the root, the session config beside the base one included' {
        $a = New-NvdaIni 'extracted/userConfig' "[update]`nautoCheck = True`n"
        $b = New-NvdaIni 'sessionUserConfig' "[update]`nautoCheck = True`n"
        $result = Set-NvdaUpdateState $script:Root $false
        $result.examined | Should -Be 2
        $result.patched | Should -Contain $a
        $result.patched | Should -Contain $b
    }

    It 'examines files but WRITES NOTHING in check mode' {
        $ini = New-NvdaIni 'nvda' "[update]`nautoCheck = True`n"
        $before = Get-Content -LiteralPath $ini -Raw
        $result = Set-NvdaUpdateState $script:Root $true
        $result.patched | Should -Contain $ini
        (Get-Content -LiteralPath $ini -Raw) | Should -Be $before
    }

    It 'reports zero examined when the root has no nvda.ini at all, rather than throwing' {
        $result = Set-NvdaUpdateState $script:Root $false
        $result.examined | Should -Be 0
    }

    It 'the re-read names the file and the key that is still on, one of three' {
        $ini = New-NvdaIni 'nvda' "[update]`nautoCheck = False`nstartupNotification = False`n[addonStore]`nautomaticUpdates = enabled`n"
        $wrong = @(Get-NvdaUpdatesStillOn $script:Root)
        $wrong.Count | Should -Be 1
        $wrong[0] | Should -Match 'automaticUpdates'
        $wrong[0] | Should -Match ([regex]::Escape($ini))
    }
}
