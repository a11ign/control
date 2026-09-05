# Covers Set-SpeechViewerState and Get-SpeechViewerStillOnCount, extracted from a11y_speech_viewer.ps1
# specifically so this could be tested off Windows -- both are pure file I/O with no AnsibleModule
# reference. See TestHelpers.psm1 for why the rest of the module cannot run here at all.
#
# The module's own header names why this matters more than its size suggests: NVDA's Speech Viewer window
# is ANNOUNCED when it takes focus, so leaving it on makes "an accessible page" and "an inaccessible one"
# indistinguishable to every interaction probe -- and it fails SILENTLY, because capture-check asserts the
# probe fired, not what it heard. The re-read this file also covers is not belt and braces; the module's
# own comment calls it "the only thing that can catch it".
BeforeAll {
    Import-Module "$PSScriptRoot/TestHelpers.psm1" -Force
    $ModulePath = "$PSScriptRoot/../../../../plugins/modules/a11y_speech_viewer.ps1"
    . (Get-ModuleFunctionScriptBlock -Path $ModulePath -Name 'Set-SpeechViewerState')
    . (Get-ModuleFunctionScriptBlock -Path $ModulePath -Name 'Get-SpeechViewerStillOnCount')
}

Describe 'Set-SpeechViewerState (a11y_speech_viewer.ps1)' {
    BeforeEach {
        $script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Root | Out-Null
    }
    AfterEach {
        Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
    }

    BeforeAll {
        # Pester 5 discovers `Describe`/`It` bodies before running any of them, so a plain `function`
        # declared at this level exists only during discovery -- proven by mutation, not assumed: the
        # first version of this file defined it exactly here and every `It` below failed with
        # `CommandNotFoundException` before a single assertion ran. `BeforeAll` runs in the RUN phase.
        function script:New-NvdaIni([string]$RelativeDir, [string]$ShowSpeechViewer) {
            $dir = Join-Path $script:Root $RelativeDir
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $path = Join-Path $dir 'nvda.ini'
            Set-Content -LiteralPath $path -Value "[general]`nshowSpeechViewerAtStartup = $ShowSpeechViewer`n" -NoNewline
            return $path
        }
    }

    It 'patches a file with Speech Viewer ON to OFF, and names it in `patched`' {
        $ini = New-NvdaIni 'nvda' 'True'
        $result = Set-SpeechViewerState $script:Root $false $false
        $result.examined | Should -Be 1
        $result.patched | Should -Contain $ini
        (Get-Content -LiteralPath $ini -Raw) | Should -Match 'showSpeechViewerAtStartup = False'
    }

    It 'leaves an already-correct file untouched, and does not name it in `patched`' {
        $ini = New-NvdaIni 'nvda' 'False'
        $before = Get-Content -LiteralPath $ini -Raw
        $result = Set-SpeechViewerState $script:Root $false $false
        $result.patched | Should -BeNullOrEmpty
        (Get-Content -LiteralPath $ini -Raw) | Should -Be $before
    }

    It 'patches EVERY nvda.ini under the root, not just the first' {
        # 0.30+ writes a session config beside the base one (CLAUDE.md), so "one nvda.ini" is already the
        # wrong assumption to make anywhere in this module.
        $a = New-NvdaIni 'nvda' 'True'
        $b = New-NvdaIni 'nvda/sessionUserConfig' 'True'
        $result = Set-SpeechViewerState $script:Root $false $false
        $result.examined | Should -Be 2
        $result.patched | Should -Contain $a
        $result.patched | Should -Contain $b
    }

    It 'examines files but WRITES NOTHING in check mode' {
        $ini = New-NvdaIni 'nvda' 'True'
        $before = Get-Content -LiteralPath $ini -Raw
        $result = Set-SpeechViewerState $script:Root $false $true
        $result.patched | Should -Contain $ini
        (Get-Content -LiteralPath $ini -Raw) | Should -Be $before
    }

    It 'turns it ON, not just off, when $enabled is true — the module is not one-directional' {
        $ini = New-NvdaIni 'nvda' 'False'
        $result = Set-SpeechViewerState $script:Root $true $false
        $result.patched | Should -Contain $ini
        (Get-Content -LiteralPath $ini -Raw) | Should -Match 'showSpeechViewerAtStartup = True'
    }

    It 'reports zero examined when the root has no nvda.ini at all, rather than throwing' {
        $result = Set-SpeechViewerState $script:Root $false $false
        $result.examined | Should -Be 0
        $result.patched | Should -BeNullOrEmpty
    }
}

Describe 'Get-SpeechViewerStillOnCount (a11y_speech_viewer.ps1)' {
    BeforeEach {
        $script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Root | Out-Null
    }
    AfterEach {
        Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'is the whole reason this module re-reads: it must see a file the patch step believed it fixed' {
        # This is the module's own documented failure mode -- "capture-check asserts the probe fired, not
        # what it heard" -- reproduced directly: a file whose content claims False while still matching
        # the True pattern (a hand-corrupted fixture, standing in for a write that silently did not take).
        $dir = Join-Path $script:Root 'nvda'
        New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'nvda.ini') `
            -Value "showSpeechViewerAtStartup = False`nshowSpeechViewerAtStartup = True`n" -NoNewline
        Get-SpeechViewerStillOnCount $script:Root | Should -Be 1
    }

    It 'is zero once every file says False' {
        $dir = Join-Path $script:Root 'nvda'
        New-Item -ItemType Directory -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'nvda.ini') -Value 'showSpeechViewerAtStartup = False' -NoNewline
        Get-SpeechViewerStillOnCount $script:Root | Should -Be 0
    }

    It 'counts across MULTIPLE files, not just whether any file matches' {
        $a = Join-Path $script:Root 'nvda'; New-Item -ItemType Directory -Path $a | Out-Null
        $b = Join-Path $script:Root 'nvda/sessionUserConfig'; New-Item -ItemType Directory -Path $b | Out-Null
        Set-Content -LiteralPath (Join-Path $a 'nvda.ini') -Value 'showSpeechViewerAtStartup = True' -NoNewline
        Set-Content -LiteralPath (Join-Path $b 'nvda.ini') -Value 'showSpeechViewerAtStartup = True' -NoNewline
        Get-SpeechViewerStillOnCount $script:Root | Should -Be 2
    }
}
