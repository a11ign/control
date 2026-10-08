# Covers Get-AcTimeout, the module's own reader of the ACTIVE power scheme's AC setting, straight from
# powercfg's own text output rather than a guess. See TestHelpers.psm1 for why the AnsibleModule half of
# this file cannot run off Windows.
#
# `powercfg.exe /change` is not idempotent-reporting (the module's own header: "it exits 0 whether or not
# anything moved"), which is exactly why this function exists at all -- reading the current value first is
# what makes `changed` mean something. So the value this function extracts is the one fact standing
# between "changed" meaning something and it being a constant lie, and the parsing itself (a regex against
# powercfg's text, then a hex-string-to-minutes conversion) is exactly the kind of fragile string match
# this repo's own capture-side history has broken more than once.
BeforeAll {
    Import-Module "$PSScriptRoot/TestHelpers.psm1" -Force
    $ModulePath = "$PSScriptRoot/../../../../plugins/modules/a11y_power_timeouts.ps1"
    . (Get-ModuleFunctionScriptBlock -Path $ModulePath -Name 'Get-AcTimeout')
    # Pester's `Mock` intercepts an EXISTING command; `powercfg.exe` is a real Windows executable that
    # simply does not exist on this host at all, so Mock has nothing to find without this stub declared
    # first. Every test below replaces its body with its own `Mock`.
    function powercfg.exe {}
}

Describe 'Get-AcTimeout (a11y_power_timeouts.ps1)' {
    It 'converts a hex AC setting index, in seconds, into MINUTES' {
        # 0x258 = 600 seconds = 10 minutes.
        Mock powercfg.exe {
            if ($args[0] -eq '/getactivescheme') { return 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)' }
            if ($args[0] -eq '/query') { return '  Current AC Power Setting Index: 0x00000258' }
        }
        Get-AcTimeout 'SUB' 'SETTING' | Should -Be 10
    }

    It 'returns 0 for a setting of "never" (0x00000000), not $null and not a truthy non-zero value' {
        # 0 is this fleet's OWN desired value (never sleep on AC) -- a parser that cannot distinguish "off"
        # from "could not read" would make the one value this module exists to set look unreadable.
        Mock powercfg.exe {
            if ($args[0] -eq '/getactivescheme') { return 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)' }
            if ($args[0] -eq '/query') { return '  Current AC Power Setting Index: 0x00000000' }
        }
        $result = Get-AcTimeout 'SUB' 'SETTING'
        $result | Should -Be 0
        $result | Should -Not -BeNullOrEmpty  # PowerShell reads 0 as falsy in a boolean test; $null is not the same fact.
    }

    It 'returns $null, never zero or a throw, when the setting cannot be found in the query output' {
        # `powercfg /query` on a scheme this setting does not belong to returns 0, no matching line, and
        # this function's own comment marks the caller's contract: a value it could not read is
        # distinguishable from a value that reads as zero, because the caller (Get-AcTimeout's own
        # module) treats "could not read" as "needs setting" rather than skipping it.
        Mock powercfg.exe {
            if ($args[0] -eq '/getactivescheme') { return 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)' }
            if ($args[0] -eq '/query') { return 'Subgroup GUID: SUB' }
        }
        Get-AcTimeout 'SUB' 'SETTING' | Should -BeNullOrEmpty
    }

    It 'extracts the active scheme GUID out of the surrounding prose before querying it' {
        # The regex replaces the WHOLE line down to just the GUID; a query call receiving the untrimmed
        # line (with "Power Scheme GUID: " still attached, or the trailing "(Balanced)") would be asking
        # powercfg a different, malformed question and get nothing back for an unrelated reason.
        Mock powercfg.exe {
            param()
            if ($args[0] -eq '/getactivescheme') { return 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)' }
            if ($args[0] -eq '/query') {
                if ($args[1] -ne '381b4222-f694-41f0-9685-ff5bb260df2e') {
                    throw "queried with the wrong scheme: '$($args[1])'"
                }
                return '  Current AC Power Setting Index: 0x0000003c'
            }
        }
        Get-AcTimeout 'SUB' 'SETTING' | Should -Be 1
    }
}
