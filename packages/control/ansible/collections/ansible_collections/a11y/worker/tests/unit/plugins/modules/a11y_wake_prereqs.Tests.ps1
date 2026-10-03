# Covers the READS in a11y_wake_prereqs (#3230): the Lenovo firmware Wake-on-LAN value, and the adapter's
# non-DHCP addresses. See TestHelpers.psm1 for why the AnsibleModule half of the file cannot run off Windows.
#
# Each read has a positive and a negative fixture, asserted to DIFFER before the read is run on them.
BeforeAll {
    Import-Module "$PSScriptRoot/TestHelpers.psm1" -Force
    $ModulePath = "$PSScriptRoot/../../../../plugins/modules/a11y_wake_prereqs.ps1"
    foreach ($f in 'ConvertFrom-LenovoBiosSetting', 'Get-FirmwareWolState', 'Get-NonDhcpAddress', 'Get-IpConfigurationProblem') {
        . (Get-ModuleFunctionScriptBlock -Path $ModulePath -Name $f)
    }
    # Windows-only cmdlets, declared so Mock has something to intercept.
    function Get-NetIPAddress { param($InterfaceIndex, $AddressFamily) }
    function Get-NetIPInterface { param($InterfaceIndex, $AddressFamily) }
    $WOL_ON = [pscustomobject]@{ CurrentSetting = 'Wake on LAN,Automatic;[Optional:Disabled,Automatic,Primary]' }
    $WOL_OFF = [pscustomobject]@{ CurrentSetting = 'Wake on LAN,Disabled;[Optional:Disabled,Automatic,Primary]' }
    $OTHER = [pscustomobject]@{ CurrentSetting = 'Fast Boot,Enabled;[Optional:Disabled,Enabled]' }
}

Describe 'ConvertFrom-LenovoBiosSetting' {
    It 'splits an item from its CURRENT value and drops the option list' {
        $r = ConvertFrom-LenovoBiosSetting $WOL_ON.CurrentSetting
        $r.Item | Should -Be 'Wake on LAN'
        $r.Value | Should -Be 'Automatic'
    }

    It 'returns $null for a line that is not of the shape, never an empty value' {
        ConvertFrom-LenovoBiosSetting 'no separator here' | Should -BeNullOrEmpty
        ConvertFrom-LenovoBiosSetting '' | Should -BeNullOrEmpty
    }
}

Describe 'Get-FirmwareWolState -- firmware Wake-on-LAN, read where it can be and said where it cannot' {
    It 'the on and off fixtures are different readings before the read is run on them' {
        $WOL_ON.CurrentSetting | Should -Not -Be $WOL_OFF.CurrentSetting
    }

    It 'reads Automatic as Automatic -- and a working Automatic is a value, not a fault' {
        $s = Get-FirmwareWolState -Manufacturer 'LENOVO' -Settings @($OTHER, $WOL_ON)
        $s.Status | Should -Be 'read'
        $s.Value | Should -Be 'Automatic'
    }

    It 'reads Disabled as Disabled -- the value the caller repairs or fails by name' {
        $s = Get-FirmwareWolState -Manufacturer 'LENOVO' -Settings @($WOL_OFF)
        $s.Status | Should -Be 'read'
        $s.Value | Should -Be 'Disabled'
    }

    It 'says not-read for a machine that is not a Lenovo, with the manufacturer, and never a value' {
        $s = Get-FirmwareWolState -Manufacturer 'Dell Inc.' -Settings @($WOL_ON)
        $s.Status | Should -Be 'not-read'
        $s.Value | Should -BeNullOrEmpty
        $s.Reason | Should -BeLike "*Dell Inc.*"
    }

    It 'says unreadable, with the reason, when the Lenovo class cannot be read' {
        $s = Get-FirmwareWolState -Manufacturer 'LENOVO' -Settings $null -ReadError 'Invalid namespace'
        $s.Status | Should -Be 'unreadable'
        $s.Value | Should -BeNullOrEmpty
        $s.Reason | Should -BeLike '*Invalid namespace*'
    }

    It 'says unreadable when a Lenovo exposes no Wake on LAN item, rather than reading the first item it finds' {
        $s = Get-FirmwareWolState -Manufacturer 'LENOVO' -Settings @($OTHER)
        $s.Status | Should -Be 'unreadable'
        $s.Value | Should -BeNullOrEmpty
    }

    It 'matches the ThinkPad spelling of the item as well' {
        $tp = [pscustomobject]@{ CurrentSetting = 'WakeOnLAN,Disabled;[Optional:Disabled,Enabled]' }
        (Get-FirmwareWolState -Manufacturer 'LENOVO' -Settings @($tp)).Value | Should -Be 'Disabled'
    }
}

Describe 'Get-NonDhcpAddress / Get-IpConfigurationProblem -- the address worker 6 came up on' {
    BeforeAll {
        function Set-Address($addresses) {
            $script:addrs = $addresses
            Mock Get-NetIPAddress { $script:addrs }
        }
        function Set-Dhcp($state) {
            $script:dhcp = $state
            Mock Get-NetIPInterface { [pscustomobject]@{ Dhcp = $script:dhcp } }
        }
        $LEASED = [pscustomobject]@{ IPAddress = '192.0.2.44'; PrefixOrigin = 'Dhcp' }
        $STATIC = [pscustomobject]@{ IPAddress = '192.0.2.99'; PrefixOrigin = 'Manual' }
        $APIPA = [pscustomobject]@{ IPAddress = '169.254.7.7'; PrefixOrigin = 'WellKnown' }
    }

    It 'the leased and the static fixtures are different readings before the read is run on them' {
        $LEASED.PrefixOrigin | Should -Not -Be $STATIC.PrefixOrigin
    }

    It 'is clean for a DHCP-enabled adapter holding only a leased address' {
        Set-Dhcp 'Enabled'; Set-Address @($LEASED)
        Get-IpConfigurationProblem -AdapterName 'Ethernet' -InterfaceIndex 3 | Should -BeNullOrEmpty
    }

    It 'names a static address, with its origin' {
        Set-Dhcp 'Enabled'; Set-Address @($LEASED, $STATIC)
        $p = @(Get-IpConfigurationProblem -AdapterName 'Ethernet' -InterfaceIndex 3)
        $p | Should -HaveCount 1
        $p[0] | Should -BeLike "*'Ethernet'*192.0.2.99*Manual*"
    }

    It 'names the link-local address a failed lease leaves behind' {
        Set-Dhcp 'Enabled'; Set-Address @($APIPA)
        @(Get-IpConfigurationProblem -AdapterName 'Ethernet' -InterfaceIndex 3)[0] | Should -BeLike '*169.254.7.7*WellKnown*'
    }

    It 'names an adapter with DHCP disabled even when no address is non-DHCP' {
        Set-Dhcp 'Disabled'; Set-Address @($LEASED)
        @(Get-IpConfigurationProblem -AdapterName 'Ethernet' -InterfaceIndex 3)[0] | Should -BeLike '*DHCP Disabled*'
    }

    It 'lists only the non-DHCP addresses, so the repair removes nothing DHCP handed out' {
        Set-Address @($LEASED, $STATIC, $APIPA)
        ((Get-NonDhcpAddress -InterfaceIndex 3).IPAddress -join ',') | Should -Be '192.0.2.99,169.254.7.7'
    }
}
