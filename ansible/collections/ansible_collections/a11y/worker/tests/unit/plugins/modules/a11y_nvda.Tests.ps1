# Covers Get-NvdaState, the module's own detection of whether an NVDA install is present and intact.
# See TestHelpers.psm1 for why the AnsibleModule-dependent half of this file cannot run off Windows, and
# why this dot-sources the function from the real file's AST rather than a copy.
#
# The module's own comment names the exact incident this exists to catch: %TEMP% cleanup once deleted
# library.zip and left nvda.exe as a stub that launches and dies, "producing 'Timed out waiting for NVDA
# to be running' and no nvda.log at all" -- a healthy install is ~1700+ files, and anything under the
# threshold (or missing either of the two named payload files) is a corpse this function must NAME, not
# just refuse.
BeforeAll {
    Import-Module "$PSScriptRoot/TestHelpers.psm1" -Force
    $ModulePath = "$PSScriptRoot/../../../../plugins/modules/a11y_nvda.ps1"
    . (Get-ModuleFunctionScriptBlock -Path $ModulePath -Name 'Get-NvdaState')
}

Describe 'Get-NvdaState (a11y_nvda.ps1)' {
    BeforeEach {
        $script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Root | Out-Null
    }
    AfterEach {
        Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'reports ABSENT when no nvda.exe exists anywhere under the root' {
        $state = Get-NvdaState $script:Root 500
        $state.present | Should -BeFalse
        $state.reason | Should -Match 'no nvda\.exe'
    }

    It 'reports INTACT when file count meets the threshold and both payload files exist' {
        $dir = Join-Path $script:Root 'nvda/2024.1'
        New-Item -ItemType Directory -Path $dir | Out-Null
        'x' | Out-File (Join-Path $dir 'nvda.exe')
        'x' | Out-File (Join-Path $dir 'library.zip')
        'x' | Out-File (Join-Path $dir 'nvda_slave.exe')
        # Pad to the threshold with throwaway files, since `intact` requires the COUNT, not just the two
        # named payloads -- a corpse can carry both named files and still be missing everything else.
        1..7 | ForEach-Object { 'x' | Out-File (Join-Path $dir "extra$_.dat") }

        $state = Get-NvdaState $script:Root 10
        $state.present | Should -BeTrue
        $state.intact | Should -BeTrue
        $state.missing | Should -BeNullOrEmpty
        $state.files | Should -Be 10
    }

    It 'reports NOT intact and NAMES the missing file when library.zip is gone' {
        # This is the exact incident the module's own header describes: TEMP cleanup deleted library.zip
        # and left nvda.exe as a stub. A count-only check would have missed it if the count still cleared
        # the threshold; naming the missing file is the whole point of this function existing.
        $dir = Join-Path $script:Root 'nvda/2024.1'
        New-Item -ItemType Directory -Path $dir | Out-Null
        'x' | Out-File (Join-Path $dir 'nvda.exe')
        'x' | Out-File (Join-Path $dir 'nvda_slave.exe')
        1..20 | ForEach-Object { 'x' | Out-File (Join-Path $dir "extra$_.dat") }

        $state = Get-NvdaState $script:Root 10
        $state.present | Should -BeTrue
        $state.intact | Should -BeFalse
        $state.missing | Should -Contain 'library.zip'
        $state.missing | Should -Not -Contain 'nvda_slave.exe'
    }

    It 'reports NOT intact and NAMES nvda_slave.exe specifically when IT is the one missing' {
        # The sibling of the test above, and it is not redundant with it: BOTH named payload files are
        # checked independently (`@('library.zip', 'nvda_slave.exe') | Where-Object { -not (Test-Path ...) }`),
        # and a test that only ever removes library.zip cannot tell "checks both files" from "checks one
        # file and ignores the other" -- proven by mutation: deleting nvda_slave.exe from that list left
        # the test above green.
        $dir = Join-Path $script:Root 'nvda/2024.1'
        New-Item -ItemType Directory -Path $dir | Out-Null
        'x' | Out-File (Join-Path $dir 'nvda.exe')
        'x' | Out-File (Join-Path $dir 'library.zip')
        1..20 | ForEach-Object { 'x' | Out-File (Join-Path $dir "extra$_.dat") }

        $state = Get-NvdaState $script:Root 10
        $state.present | Should -BeTrue
        $state.intact | Should -BeFalse
        $state.missing | Should -Contain 'nvda_slave.exe'
        $state.missing | Should -Not -Contain 'library.zip'
    }

    It 'reports NOT intact when the file count is under the threshold, even with both payload files present' {
        $dir = Join-Path $script:Root 'nvda/2024.1'
        New-Item -ItemType Directory -Path $dir | Out-Null
        'x' | Out-File (Join-Path $dir 'nvda.exe')
        'x' | Out-File (Join-Path $dir 'library.zip')
        'x' | Out-File (Join-Path $dir 'nvda_slave.exe')

        $state = Get-NvdaState $script:Root 500
        $state.intact | Should -BeFalse
        $state.missing | Should -BeNullOrEmpty
        $state.files | Should -BeLessThan 500
    }

    It 'picks the LATEST nvda.exe by path when more than one install directory exists' {
        # `Sort-Object FullName -Descending | Select-Object -First 1` is a real behavioural choice, not
        # an arbitrary tiebreak: a stale prior version left on disk must not be read as the current one.
        $old = Join-Path $script:Root 'nvda/2023.1'
        $new = Join-Path $script:Root 'nvda/2024.1'
        New-Item -ItemType Directory -Path $old | Out-Null
        New-Item -ItemType Directory -Path $new | Out-Null
        'x' | Out-File (Join-Path $old 'nvda.exe')
        'x' | Out-File (Join-Path $new 'nvda.exe')
        'x' | Out-File (Join-Path $new 'library.zip')
        'x' | Out-File (Join-Path $new 'nvda_slave.exe')

        $state = Get-NvdaState $script:Root 3
        $state.dir | Should -Be $new
    }
}
