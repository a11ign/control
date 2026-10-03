# Covers the READS in a11y_nic_power (#3230): whether Windows will honour a wake (`powercfg /devicequery
# wake_armed`), whether the NDIS wake keywords read as wanted, and whether hibernation is off. See
# TestHelpers.psm1 for why the AnsibleModule half of the file cannot run off Windows.
#
# Every read here has a POSITIVE and a NEGATIVE case, and the pair is asserted to DIFFER before the read is
# run on it: a fixture pair that cannot be told apart would make "the read says unarmed" pass for a read that
# returns the same thing for both.
BeforeAll {
    Import-Module "$PSScriptRoot/TestHelpers.psm1" -Force
    $ModulePath = "$PSScriptRoot/../../../../plugins/modules/a11y_nic_power.ps1"
    # The wanted-keyword table and the registry key are top-level constants of the module, not functions, so
    # they are read out of the same parsed AST rather than retyped here.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($ModulePath, [ref]$null, [ref]$null)
    $assign = { param($name) $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq $name }, $true) | Select-Object -First 1 }
    $WAKE_PROPERTIES = & ([scriptblock]::Create((& $assign '$WAKE_PROPERTIES').Right.Extent.Text))
    $HIBERNATE_KEY = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'
    foreach ($f in 'Get-WakeArmedDevice', 'Test-WakeArmed', 'Get-WakePropertyVerdict', 'Get-HibernateEnabled', 'Get-WakeFailure', 'Get-HibernateFailure') {
        . (Get-ModuleFunctionScriptBlock -Path $ModulePath -Name $f)
    }
    # Pester's Mock intercepts an EXISTING command; these only exist on Windows, so each is declared first.
    function powercfg.exe {}
    function Get-NetAdapterAdvancedProperty { param($Name, $RegistryKeyword) }
    $ARMED = @('Intel(R) Ethernet Connection (2) I219-V', 'HID Keyboard Device')
    $UNARMED = @('HID Keyboard Device')
    $NIC = [pscustomobject]@{ Name = 'Ethernet'; InterfaceDescription = 'Intel(R) Ethernet Connection (2) I219-V' }
}

Describe 'Get-WakeArmedDevice / Test-WakeArmed -- does Windows list the adapter as wake-armed' {
    It 'the armed and unarmed fixtures are different readings before the read is run on them' {
        # The positive control: if these two could not be told apart, every test below would be vacuous.
        $ARMED | Should -Not -Be $UNARMED
        $ARMED -contains $NIC.InterfaceDescription | Should -BeTrue
        $UNARMED -contains $NIC.InterfaceDescription | Should -BeFalse
    }

    It 'is TRUE when the adapter is in the armed list' {
        Mock powercfg.exe { $global:LASTEXITCODE = 0; return $ARMED }
        Test-WakeArmed $NIC.InterfaceDescription | Should -BeTrue
    }

    It 'is FALSE when the adapter is NOT in the armed list -- the unarmed case that stopped worker 4' {
        Mock powercfg.exe { $global:LASTEXITCODE = 0; return $UNARMED }
        Test-WakeArmed $NIC.InterfaceDescription | Should -BeFalse
    }

    It 'is FALSE when powercfg says NONE, and the word NONE is not read as a device' {
        Mock powercfg.exe { $global:LASTEXITCODE = 0; return @('NONE') }
        Get-WakeArmedDevice | Should -BeNullOrEmpty
        Test-WakeArmed 'NONE' | Should -BeFalse
    }

    It 'matches a device name case-insensitively and ignores the padding powercfg prints' {
        Mock powercfg.exe { $global:LASTEXITCODE = 0; return @('  intel(r) ethernet connection (2) i219-v  ') }
        Test-WakeArmed $NIC.InterfaceDescription | Should -BeTrue
    }

    It 'THROWS when powercfg fails, rather than reading the failure as "nothing is armed"' {
        Mock powercfg.exe { $global:LASTEXITCODE = 1; return @('You do not have permission to run this command.') }
        { Get-WakeArmedDevice } | Should -Throw '*was NOT read*'
    }
}

Describe 'Get-WakePropertyVerdict -- the NDIS wake keywords, read rather than assumed' {
    BeforeAll {
        # One property bag per keyword, as Get-NetAdapterAdvancedProperty returns it; a keyword missing from
        # the table returns nothing, which is how a driver that does not expose it answers.
        function Set-Properties($table) {
            $script:props = $table
            Mock Get-NetAdapterAdvancedProperty {
                if ($script:props.ContainsKey($RegistryKeyword)) { [pscustomobject]@{ RegistryValue = @($script:props[$RegistryKeyword]) } }
            }
        }
    }

    It 'the wanted and the wrong tables are different readings before the read is run on them' {
        $good = @{ '*WakeOnMagicPacket' = '1'; '*WakeOnPattern' = '0'; '*EEE' = '0' }
        $bad = @{ '*WakeOnMagicPacket' = '0'; '*WakeOnPattern' = '1'; '*EEE' = '1' }
        ($good.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) |
            Should -Not -Be ($bad.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" })
    }

    It 'wants magic packet ON, pattern wake OFF and EEE OFF -- read from the module, not retyped here' {
        ($WAKE_PROPERTIES | Where-Object Keyword -eq '*WakeOnMagicPacket').Want | Should -Be '1'
        ($WAKE_PROPERTIES | Where-Object Keyword -eq '*WakeOnPattern').Want | Should -Be '0'
        ($WAKE_PROPERTIES | Where-Object Keyword -eq '*EEE').Want | Should -Be '0'
    }

    It 'reports ok for every keyword that reads as wanted' {
        Set-Properties @{ '*WakeOnMagicPacket' = '1'; '*WakeOnPattern' = '0'; '*EEE' = '0' }
        $v = Get-WakePropertyVerdict -AdapterName 'Ethernet' -Wanted $WAKE_PROPERTIES
        ($v | Where-Object Status -ne 'ok') | Should -BeNullOrEmpty
        $v.Count | Should -Be 3
    }

    It 'reports WRONG, with the value it read, for a keyword that is not as wanted' {
        Set-Properties @{ '*WakeOnMagicPacket' = '1'; '*WakeOnPattern' = '1'; '*EEE' = '0' }
        $v = Get-WakePropertyVerdict -AdapterName 'Ethernet' -Wanted $WAKE_PROPERTIES
        $w = $v | Where-Object Keyword -eq '*WakeOnPattern'
        $w.Status | Should -Be 'wrong'
        $w.Got | Should -Be '1'
    }

    It 'reports not-exposed for a keyword the driver lacks, and unreadable when there is no cmdlet at all' {
        Set-Properties @{ '*WakeOnMagicPacket' = '1' }
        (Get-WakePropertyVerdict -AdapterName 'Ethernet' -Wanted $WAKE_PROPERTIES | Where-Object Keyword -eq '*EEE').Status |
            Should -Be 'not-exposed'
        Mock Get-Command { $null }
        (Get-WakePropertyVerdict -AdapterName 'Ethernet' -Wanted $WAKE_PROPERTIES).Status | Select-Object -Unique |
            Should -Be 'unreadable'
    }
}

Describe 'Get-WakeFailure -- one adapter, every reason it cannot be woken' {
    BeforeAll {
        Mock Get-NetAdapterAdvancedProperty {
            $v = @{ '*WakeOnMagicPacket' = '1'; '*WakeOnPattern' = '0'; '*EEE' = '0' }[$RegistryKeyword]
            [pscustomobject]@{ RegistryValue = @($v) }
        }
    }

    It 'is EMPTY for an armed adapter whose keywords read as wanted' {
        Mock powercfg.exe { $global:LASTEXITCODE = 0; return $ARMED }
        Get-WakeFailure -Adapter $NIC -Wanted $WAKE_PROPERTIES | Should -BeNullOrEmpty
    }

    It 'names the adapter when it is not armed, even though every adapter property is right' {
        Mock powercfg.exe { $global:LASTEXITCODE = 0; return $UNARMED }
        $f = @(Get-WakeFailure -Adapter $NIC -Wanted $WAKE_PROPERTIES)
        $f.Count | Should -Be 1
        $f[0] | Should -BeLike "*'Ethernet'*not in powercfg /devicequery wake_armed*"
    }

    It 'fails a driver that does not expose the magic-packet keyword, which cannot wake at all' {
        Mock powercfg.exe { $global:LASTEXITCODE = 0; return $ARMED }
        Mock Get-NetAdapterAdvancedProperty { }
        $f = @(Get-WakeFailure -Adapter $NIC -Wanted $WAKE_PROPERTIES)
        $f | Should -HaveCount 1
        $f[0] | Should -BeLike '*WakeOnMagicPacket is not exposed*'
    }
}

Describe 'Get-HibernateFailure -- hibernation off, read through a different instrument than the writer' {
    It 'is NULL when HibernateEnabled reads 0' {
        Mock Get-ItemProperty { [pscustomobject]@{ HibernateEnabled = 0 } }
        Get-HibernateFailure | Should -BeNullOrEmpty
    }

    It 'names the problem when hibernation is ON' {
        Mock Get-ItemProperty { [pscustomobject]@{ HibernateEnabled = 1 } }
        Get-HibernateFailure | Should -BeLike '*hibernation is ON*'
    }

    It 'says the value could NOT be read, rather than passing, when the key has no value' {
        Mock Get-ItemProperty { $null }
        Get-HibernateEnabled | Should -BeNullOrEmpty
        Get-HibernateFailure | Should -BeLike '*could NOT be read*'
    }
}
