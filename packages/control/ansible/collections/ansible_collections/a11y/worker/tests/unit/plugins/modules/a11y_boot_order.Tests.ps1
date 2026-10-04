# Covers the READS and the DECISIONS in a11y_boot_order (#3387): the Lenovo and HP boot-order reads, the
# `bcdedit /enum firmware` read, the write guard, the wake-sequence verdict and the ships-OFF switch. See
# TestHelpers.psm1 for why the AnsibleModule half of the file cannot run off Windows.
#
# No test here boots a box, and none could: `autounattend.xml` wipes disk 0. The claim these pin is "boot order
# decided, written and read back", never "a PXE hijack cannot happen".
#
# Every read has a positive and a negative fixture, asserted to DIFFER before the read is run on them.
BeforeAll {
    Import-Module "$PSScriptRoot/TestHelpers.psm1" -Force
    $ModulePath = "$PSScriptRoot/../../../../plugins/modules/a11y_boot_order.ps1"
    foreach ($f in 'Get-BootVendor', 'Test-NetworkBootMember', 'Get-BootOrderTarget', 'Test-SameMembers',
        'ConvertFrom-LenovoBootSetting', 'Get-BootItemName', 'Get-LenovoBootState', 'Get-HpBootState',
        'Get-FirmwareBootEntryState', 'Get-WakeSequenceState', 'Get-BootOrderPlan', 'Get-BootOrderVerdict',
        'Get-RebuildPathState', 'Read-BootOrder', 'Set-LenovoBootOrder', 'Set-HpBootOrder',
        'Invoke-BootOrderEnforcement') {
        . (Get-ModuleFunctionScriptBlock -Path $ModulePath -Name $f)
    }
    $LENOVO_NAMESPACE = 'root\wmi'
    $HP_NAMESPACE = 'root\HP\InstrumentedBIOS'

    function Lenovo($line) { [pscustomobject]@{ CurrentSetting = $line } }
    $L_NET = Lenovo 'Primary Boot Sequence,PCI LAN:Hard Drive:USB Storage'
    $L_DISK = Lenovo 'Primary Boot Sequence,Hard Drive:USB Storage'
    $L_WOL_AUTO = Lenovo 'Wake on LAN,Automatic;[Optional:Disabled,Automatic,Primary]'
    $L_WOL_PRIMARY = Lenovo 'Wake on LAN,Primary;[Optional:Disabled,Automatic,Primary]'
    $L_AUTO_NET = Lenovo 'Automatic Boot Sequence,Network Boot:Hard Drive'
    $L_AUTO_DISK = Lenovo 'Automatic Boot Sequence,Hard Drive'
    $L_OTHER = Lenovo 'Fast Boot,Enabled;[Optional:Disabled,Enabled]'

    $HP_NET = [pscustomobject]@{ Name = 'UEFI Boot Order'; Value = 'NETWORK IPV4:EMBEDDED:1,HDD:M.2:1,HDD:USB:1'; IsReadOnly = 0 }
    $HP_DISK = [pscustomobject]@{ Name = 'UEFI Boot Order'; Value = 'HDD:M.2:1,HDD:USB:1'; IsReadOnly = 0 }

    $BCD_NET_FIRST = @'
Firmware Boot Manager
---------------------
identifier              {fwbootmgr}
displayorder            {aaaa0001-0000-0000-0000-000000000000}
                        {bbbb0002-0000-0000-0000-000000000000}
timeout                 0

Firmware Application (101fffff)
-------------------------------
identifier              {aaaa0001-0000-0000-0000-000000000000}
description             EFI Network 1 for IPv4 (00-11-22-33-44-55)

Windows Boot Manager
--------------------
identifier              {bbbb0002-0000-0000-0000-000000000000}
description             Windows Boot Manager
'@
    $BCD_NO_NET_IN_ORDER = $BCD_NET_FIRST -replace '(?m)^displayorder\s+\{aaaa0001[^\r\n]*\r?\n\s+', 'displayorder            '
    $BCD_NO_NET_AT_ALL = ($BCD_NET_FIRST -replace '(?s)Firmware Application \(101fffff\).*?(?=Windows Boot Manager)', '') -replace '(?m)^displayorder\s+\{aaaa0001[^\r\n]*\r?\n\s+', 'displayorder            '
}

Describe 'Test-NetworkBootMember / Get-BootOrderTarget -- what counts as network, and what is left' {
    It 'recognises the network spellings both vendors use' {
        foreach ($m in 'PCI LAN', 'Network Boot', 'NETWORK IPV4:EMBEDDED:1', 'EFI Network 1 for IPv4', 'Onboard NIC', 'UEFI HTTP Boot', 'PXE') {
            Test-NetworkBootMember $m | Should -BeTrue -Because $m
        }
    }

    It 'does not call a disk a network device' {
        foreach ($m in 'Hard Drive', 'USB Storage', 'HDD:M.2:1', 'Windows Boot Manager', 'CD/DVD') {
            Test-NetworkBootMember $m | Should -BeFalse -Because $m
        }
    }

    It 'keeps every non-network member, in the order it was read, and adds none' {
        (Get-BootOrderTarget @('PCI LAN', 'Hard Drive', 'USB Storage')) -join ':' | Should -Be 'Hard Drive:USB Storage'
        (Get-BootOrderTarget @('USB Storage', 'NETWORK IPV4:EMBEDDED:1', 'HDD:M.2:1')) -join ':' | Should -Be 'USB Storage:HDD:M.2:1'
    }

    It 'leaves an order with no network member exactly as it was' {
        (Get-BootOrderTarget @('Hard Drive', 'USB Storage')) -join ':' | Should -Be 'Hard Drive:USB Storage'
    }
}

Describe 'Get-BootVendor' {
    It 'names Lenovo and HP and nothing else' {
        Get-BootVendor 'LENOVO' | Should -Be 'Lenovo'
        Get-BootVendor 'HP' | Should -Be 'HP'
        Get-BootVendor 'Hewlett-Packard' | Should -Be 'HP'
        Get-BootVendor 'Dell Inc.' | Should -BeNullOrEmpty
    }
}

Describe 'Get-LenovoBootState -- the Lenovo boot order, read by name' {
    It 'the network-first and disk-first fixtures are different readings before the read is run on them' {
        $L_NET.CurrentSetting | Should -Not -Be $L_DISK.CurrentSetting
    }

    It 'reads a network-first order as network-first, with every member' {
        $s = Get-LenovoBootState -Settings @($L_OTHER, $L_NET, $L_WOL_AUTO)
        $s.Status | Should -Be 'read'
        $s.Setting | Should -Be 'Primary Boot Sequence'
        $s.Members -join ':' | Should -Be 'PCI LAN:Hard Drive:USB Storage'
        $s.WakeOnLan | Should -Be 'Automatic'
    }

    It 'reads a disk-first order as disk-first' {
        (Get-LenovoBootState -Settings @($L_DISK)).Members -join ':' | Should -Be 'Hard Drive:USB Storage'
    }

    It 'reads the Automatic Boot Sequence beside the primary one' {
        (Get-LenovoBootState -Settings @($L_NET, $L_AUTO_NET)).AutomaticMembers -join ':' | Should -Be 'Network Boot:Hard Drive'
    }

    It 'says unreadable, with the reason, when the class cannot be read' {
        $s = Get-LenovoBootState -Settings $null -ReadError 'Invalid namespace'
        $s.Status | Should -Be 'unreadable'
        $s.Reason | Should -BeLike '*Invalid namespace*'
        $s.Members | Should -BeNullOrEmpty
    }

    It 'says unreadable and LISTS the boot-looking items it saw, when none is a boot order' {
        $s = Get-LenovoBootState -Settings @($L_OTHER, $L_WOL_AUTO)
        $s.Status | Should -Be 'unreadable'
        $s.Reason | Should -BeLike '*no boot-order item*'
        $s.ItemsSeen | Should -Contain 'Fast Boot'
    }

    It 'refuses a value that is not an ordered list, rather than writing one member back' {
        $s = Get-LenovoBootState -Settings @((Lenovo 'Boot Order,Automatic'))
        $s.Status | Should -Be 'unreadable'
        $s.Reason | Should -BeLike '*not an ordered list*'
    }
}

Describe 'Get-HpBootState -- the HP boot order, from the documented interface' {
    It 'the network-first and disk-first fixtures are different readings before the read is run on them' {
        $HP_NET.Value | Should -Not -Be $HP_DISK.Value
    }

    It 'reads a network-first order as network-first' {
        $s = Get-HpBootState -Settings @($HP_NET)
        $s.Status | Should -Be 'read'
        $s.Setting | Should -Be 'UEFI Boot Order'
        $s.Members[0] | Should -Be 'NETWORK IPV4:EMBEDDED:1'
        $s.Members.Count | Should -Be 3
    }

    It 'reads a disk-first order as disk-first' {
        (Get-HpBootState -Settings @($HP_DISK)).Members -join ',' | Should -Be 'HDD:M.2:1,HDD:USB:1'
    }

    It 'prefers the UEFI list when a box carries both' {
        $legacy = [pscustomobject]@{ Name = 'Legacy Boot Order'; Value = 'HDD:M.2:1,NETWORK IPV4:EMBEDDED:1'; IsReadOnly = 0 }
        (Get-HpBootState -Settings @($legacy, $HP_DISK)).Setting | Should -Be 'UEFI Boot Order'
    }

    It 'says unreadable with the reason when the class cannot be read' {
        (Get-HpBootState -Settings $null -ReadError 'Invalid namespace').Reason | Should -BeLike '*Invalid namespace*'
    }

    It 'says unreadable and lists the names it saw when there is no boot list' {
        $s = Get-HpBootState -Settings @([pscustomobject]@{ Name = 'Boot Delay'; Value = '0'; IsReadOnly = 0 })
        $s.Status | Should -Be 'unreadable'
        $s.ItemsSeen | Should -Contain 'Boot Delay'
    }

    It 'says unreadable for a read-only list instead of attempting a write that cannot succeed' {
        $ro = [pscustomobject]@{ Name = 'UEFI Boot Order'; Value = 'NETWORK IPV4:EMBEDDED:1,HDD:M.2:1'; IsReadOnly = 1 }
        (Get-HpBootState -Settings @($ro)).Status | Should -Be 'unreadable'
    }
}

Describe 'Get-FirmwareBootEntryState -- bcdedit /enum firmware, the cross-vendor second reading' {
    It 'the network-first and no-network fixtures are different readings before the read is run on them' {
        $BCD_NET_FIRST | Should -Not -Be $BCD_NO_NET_IN_ORDER
    }

    It 'reads the order by description, and finds Network first' {
        $s = Get-FirmwareBootEntryState -BcdeditText $BCD_NET_FIRST
        $s.Status | Should -Be 'read'
        $s.Order[0] | Should -BeLike 'EFI Network*'
        $s.NetworkInOrder | Should -BeTrue
        $s.NetworkEntries | Should -HaveCount 1
    }

    It 'reads an order without Network, while the entry is still listed (addressable for a BootNext)' {
        $s = Get-FirmwareBootEntryState -BcdeditText $BCD_NO_NET_IN_ORDER
        $s.NetworkInOrder | Should -BeFalse
        $s.NetworkEntries | Should -HaveCount 1
    }

    It 'reads no network entry when the firmware lists none' {
        $s = Get-FirmwareBootEntryState -BcdeditText $BCD_NO_NET_AT_ALL
        $s.Status | Should -Be 'read'
        $s.NetworkEntries | Should -HaveCount 0
    }

    It 'says unreadable for a failed bcdedit and for text with no entries, never an empty order' {
        (Get-FirmwareBootEntryState -BcdeditText '' -ReadError 'exit 1').Status | Should -Be 'unreadable'
        (Get-FirmwareBootEntryState -BcdeditText 'The boot configuration data store could not be opened.').Status | Should -Be 'unreadable'
    }
}

Describe 'Get-WakeSequenceState -- was the sequence a wake uses SHOWN to omit Network' {
    It 'Lenovo Primary wakes through the stored order: shown when it omits Network, not when it lists it' {
        (Get-WakeSequenceState -Vendor 'Lenovo' -WakeOnLan 'Primary' -PrimaryMembers @('Hard Drive')).State | Should -Be 'omits-network'
        (Get-WakeSequenceState -Vendor 'Lenovo' -WakeOnLan 'Primary' -PrimaryMembers @('PCI LAN', 'Hard Drive')).State | Should -Be 'includes-network'
    }

    It 'Lenovo Automatic is shown only from an Automatic Boot Sequence the box lists' {
        (Get-WakeSequenceState -Vendor 'Lenovo' -WakeOnLan 'Automatic' -PrimaryMembers @('Hard Drive') -AutomaticMembers @('Hard Drive')).State | Should -Be 'omits-network'
        (Get-WakeSequenceState -Vendor 'Lenovo' -WakeOnLan 'Automatic' -PrimaryMembers @('Hard Drive') -AutomaticMembers @('Network Boot', 'Hard Drive')).State | Should -Be 'includes-network'
        $s = Get-WakeSequenceState -Vendor 'Lenovo' -WakeOnLan 'Automatic' -PrimaryMembers @('Hard Drive')
        $s.State | Should -Be 'UNREAD'
        $s.Reason | Should -BeLike '*starts with Network*'
    }

    It 'is UNREAD for a disabled or unread Wake on LAN, and for every HP box' {
        (Get-WakeSequenceState -Vendor 'Lenovo' -WakeOnLan 'Disabled' -PrimaryMembers @('Hard Drive')).State | Should -Be 'UNREAD'
        (Get-WakeSequenceState -Vendor 'Lenovo' -WakeOnLan $null -PrimaryMembers @('Hard Drive')).State | Should -Be 'UNREAD'
        (Get-WakeSequenceState -Vendor 'HP' -PrimaryMembers @('HDD:M.2:1')).State | Should -Be 'UNREAD'
    }
}

Describe 'Get-BootOrderPlan -- the write guard, and the ships-OFF switch' {
    BeforeAll {
        $NET_FIRST = [pscustomobject]@{ Status = 'read'; Setting = 'Primary Boot Sequence'; Members = @('PCI LAN', 'Hard Drive', 'USB Storage') }
        $NO_NET = [pscustomobject]@{ Status = 'read'; Setting = 'Primary Boot Sequence'; Members = @('Hard Drive', 'USB Storage') }
        $ONLY_NET = [pscustomobject]@{ Status = 'read'; Setting = 'Primary Boot Sequence'; Members = @('PCI LAN', 'Network Boot') }
    }

    It 'the network-first and no-network readings differ before the plan is run on them' {
        ($NET_FIRST.Members -join ':') | Should -Not -Be ($NO_NET.Members -join ':')
    }

    It 'OFF: a network-first order is reported and NOT written (this is the control for the next test)' {
        $p = Get-BootOrderPlan -Read $NET_FIRST -Enforce $false
        $p.Action | Should -Be 'report'
        $p.Reason | Should -BeLike '*enforcement is off*'
    }

    It 'ON: the same network-first order is written, as the box''s own members minus network' {
        $p = Get-BootOrderPlan -Read $NET_FIRST -Enforce $true
        $p.Action | Should -Be 'write'
        $p.Target -join ':' | Should -Be 'Hard Drive:USB Storage'
    }

    It 'writes nothing for an order that already holds no network member, on or off' {
        (Get-BootOrderPlan -Read $NO_NET -Enforce $true).Action | Should -Be 'none'
        (Get-BootOrderPlan -Read $NO_NET -Enforce $false).Action | Should -Be 'none'
    }

    It 'refuses to leave nothing to boot from' {
        $p = Get-BootOrderPlan -Read $ONLY_NET -Enforce $true
        $p.Action | Should -Be 'refuse'
        $p.Target | Should -BeNullOrEmpty
    }

    It 'plans nothing for a reading that was not a read' {
        (Get-BootOrderPlan -Read ([pscustomobject]@{ Status = 'unreadable'; Members = @() }) -Enforce $true).Action | Should -Be 'none'
    }
}

Describe 'Get-BootOrderVerdict -- the one word, and when it may be ok' {
    BeforeAll {
        $BEFORE = [pscustomobject]@{ Status = 'read'; Vendor = 'Lenovo'; Setting = 'Primary Boot Sequence'; Members = @('PCI LAN', 'Hard Drive') }
        $WRITE = [pscustomobject]@{ Action = 'write'; Target = @('Hard Drive'); Reason = $null }
        $NONE = [pscustomobject]@{ Action = 'none'; Target = @(); Reason = $null }
        $AFTER_RIGHT = [pscustomobject]@{ Status = 'read'; Members = @('Hard Drive') }
        $AFTER_WRONG = [pscustomobject]@{ Status = 'read'; Members = @('PCI LAN', 'Hard Drive') }
        $SHOWN = [pscustomobject]@{ State = 'omits-network'; Reason = 'shown' }
        $UNSHOWN = [pscustomobject]@{ State = 'UNREAD'; Reason = 'Wake on LAN is Automatic' }
        $LIVE_OK = [pscustomobject]@{ Status = 'read'; NetworkInOrder = $false; Order = @('Windows Boot Manager'); Reason = $null }
        $LIVE_NET = [pscustomobject]@{ Status = 'read'; NetworkInOrder = $true; Order = @('EFI Network', 'Windows Boot Manager'); Reason = $null }
    }

    It 'changed: written, read back equal to the target, and every caveat answered' {
        (Get-BootOrderVerdict -Before $BEFORE -Plan $WRITE -After $AFTER_RIGHT -Wake $SHOWN -Live $LIVE_OK -CheckMode $false).Status | Should -Be 'changed'
    }

    It 'failed, naming the read-back, when what the box stored is not the target' {
        $v = Get-BootOrderVerdict -Before $BEFORE -Plan $WRITE -After $AFTER_WRONG -Wake $SHOWN -Live $LIVE_OK -CheckMode $false
        $v.Status | Should -Be 'failed'
        $v.Reasons[0] | Should -BeLike '*read-back*PCI LAN:Hard Drive*Hard Drive*'
    }

    It 'failed, naming the refusal, when the setter threw' {
        $v = Get-BootOrderVerdict -Before $BEFORE -Plan $WRITE -After $BEFORE -WriteError 'SetBiosSetting answered ''Access Denied''' -Wake $SHOWN -Live $LIVE_OK -CheckMode $false
        $v.Status | Should -Be 'failed'
        $v.Reasons[0] | Should -BeLike '*Access Denied*'
    }

    It 'is never ok or changed while the wake sequence is not shown: order-set, with the reason' {
        $v = Get-BootOrderVerdict -Before $BEFORE -Plan $WRITE -After $AFTER_RIGHT -Wake $UNSHOWN -Live $LIVE_OK -CheckMode $false
        $v.Status | Should -Be 'order-set'
        $v.Reasons -join ' ' | Should -BeLike '*wake-sequence UNREAD*'
    }

    It 'is never ok while the live firmware order still lists Network, or was not read' {
        (Get-BootOrderVerdict -Before $BEFORE -Plan $NONE -After $BEFORE -Wake $SHOWN -Live $LIVE_NET -CheckMode $false).Status | Should -Be 'order-set'
        $unread = [pscustomobject]@{ Status = 'unreadable'; NetworkInOrder = $false; Order = @(); Reason = 'exit 1' }
        (Get-BootOrderVerdict -Before $BEFORE -Plan $NONE -After $BEFORE -Wake $SHOWN -Live $unread -CheckMode $false).Status | Should -Be 'order-set'
    }

    It 'ok: nothing to write, and nothing left unshown' {
        (Get-BootOrderVerdict -Before $BEFORE -Plan $NONE -After $BEFORE -Wake $SHOWN -Live $LIVE_OK -CheckMode $false).Status | Should -Be 'ok'
    }

    It 'needs-change when enforcement is off or this is check mode, and writes nothing in either' {
        $report = [pscustomobject]@{ Action = 'report'; Target = @('Hard Drive'); Reason = 'enforcement is off' }
        (Get-BootOrderVerdict -Before $BEFORE -Plan $report -After $BEFORE -Wake $SHOWN -Live $LIVE_OK -CheckMode $false).Status | Should -Be 'needs-change'
        (Get-BootOrderVerdict -Before $BEFORE -Plan $WRITE -After $BEFORE -Wake $SHOWN -Live $LIVE_OK -CheckMode $true).Status | Should -Be 'needs-change'
    }

    It 'carries not-read for a box that is neither vendor, and unreadable for one that is' {
        $other = [pscustomobject]@{ Status = 'not-read'; Vendor = $null; Reason = 'manufacturer is ''Dell Inc.''' }
        $unread = [pscustomobject]@{ Status = 'unreadable'; Vendor = 'HP'; Reason = 'no boot list' }
        (Get-BootOrderVerdict -Before $other -Plan $NONE -After $other -Wake $UNSHOWN -Live $LIVE_OK -CheckMode $false).Status | Should -Be 'not-read'
        (Get-BootOrderVerdict -Before $unread -Plan $NONE -After $unread -Wake $UNSHOWN -Live $LIVE_OK -CheckMode $false).Status | Should -Be 'unreadable'
    }
}

Describe 'Get-RebuildPathState -- is a network entry still there for a one-time BootNext' {
    It 'says yes naming the entry, no saying a rebuild is a console visit, and UNREAD when it was not read' {
        $yes = Get-RebuildPathState -Live ([pscustomobject]@{ Status = 'read'; NetworkEntries = @('EFI Network 1') })
        $yes.Addressable | Should -Be 'yes'
        $yes.Reason | Should -BeLike '*EFI Network 1*'
        $no = Get-RebuildPathState -Live ([pscustomobject]@{ Status = 'read'; NetworkEntries = @() })
        $no.Addressable | Should -Be 'no'
        $no.Reason | Should -BeLike '*console visit*'
        (Get-RebuildPathState -Live ([pscustomobject]@{ Status = 'unreadable'; Reason = 'x' })).Addressable | Should -Be 'UNREAD'
    }
}

Describe 'Invoke-BootOrderEnforcement -- the ONE place a setter is called' {
    BeforeAll {
        # Windows-only cmdlets, declared so Mock has something to intercept.
        function Get-CimInstance { param($Namespace, $ClassName) }
        $script:reads = 0
        function Use-Boxes($before, $after) {
            $script:reads = 0
            $script:boxes = @($before, $after)
            Mock Read-BootOrder { $script:boxes[[Math]::Min($script:reads++, 1)] }
            Mock Set-LenovoBootOrder { }
            Mock Set-HpBootOrder { }
        }
        $LENOVO_NET_FIRST = [pscustomobject]@{ Vendor = 'Lenovo'; Status = 'read'; Setting = 'Primary Boot Sequence'; Members = @('PCI LAN', 'Hard Drive') }
        $LENOVO_STORED = [pscustomobject]@{ Vendor = 'Lenovo'; Status = 'read'; Setting = 'Primary Boot Sequence'; Members = @('Hard Drive') }
        $HP_NET_FIRST = [pscustomobject]@{ Vendor = 'HP'; Status = 'read'; Setting = 'UEFI Boot Order'; Members = @('NETWORK IPV4:EMBEDDED:1', 'HDD:M.2:1') }
        $HP_STORED = [pscustomobject]@{ Vendor = 'HP'; Status = 'read'; Setting = 'UEFI Boot Order'; Members = @('HDD:M.2:1') }
    }

    It 'OFF: calls no setter, for either vendor, and the order it hands back is the one it read' {
        Use-Boxes $LENOVO_NET_FIRST $LENOVO_STORED
        $r = Invoke-BootOrderEnforcement -Manufacturer 'LENOVO' -Enforce $false -CheckMode $false
        Should -Invoke Set-LenovoBootOrder -Times 0 -Exactly
        $r.After.Members -join ':' | Should -Be 'PCI LAN:Hard Drive'
        Use-Boxes $HP_NET_FIRST $HP_STORED
        Invoke-BootOrderEnforcement -Manufacturer 'HP' -Enforce $false -CheckMode $false | Out-Null
        Should -Invoke Set-HpBootOrder -Times 0 -Exactly
    }

    It 'ON: the Lenovo setter IS called for a box whose order starts with Network, then the order is read back' {
        Use-Boxes $LENOVO_NET_FIRST $LENOVO_STORED
        $r = Invoke-BootOrderEnforcement -Manufacturer 'LENOVO' -Enforce $true -CheckMode $false
        Should -Invoke Set-LenovoBootOrder -Times 1 -Exactly -ParameterFilter { $Setting -eq 'Primary Boot Sequence' -and ($Members -join ':') -eq 'Hard Drive' }
        Should -Invoke Read-BootOrder -Times 2 -Exactly
        $r.After.Members -join ':' | Should -Be 'Hard Drive'
    }

    It 'ON: the HP setter IS called for a box whose order starts with Network' {
        Use-Boxes $HP_NET_FIRST $HP_STORED
        Invoke-BootOrderEnforcement -Manufacturer 'HP' -Enforce $true -CheckMode $false | Out-Null
        Should -Invoke Set-HpBootOrder -Times 1 -Exactly -ParameterFilter { $Setting -eq 'UEFI Boot Order' -and ($Members -join ',') -eq 'HDD:M.2:1' }
        Should -Invoke Set-LenovoBootOrder -Times 0 -Exactly
    }

    It 'ON, but check mode: calls no setter' {
        Use-Boxes $LENOVO_NET_FIRST $LENOVO_STORED
        Invoke-BootOrderEnforcement -Manufacturer 'LENOVO' -Enforce $true -CheckMode $true | Out-Null
        Should -Invoke Set-LenovoBootOrder -Times 0 -Exactly
    }

    It 'ON: a setter that throws is carried as WriteError, and no read-back is attempted over it' {
        Use-Boxes $LENOVO_NET_FIRST $LENOVO_STORED
        Mock Set-LenovoBootOrder { throw "SetBiosSetting answered 'Access Denied'" }
        $r = Invoke-BootOrderEnforcement -Manufacturer 'LENOVO' -Enforce $true -CheckMode $false
        $r.WriteError | Should -BeLike '*Access Denied*'
        Should -Invoke Read-BootOrder -Times 1 -Exactly
    }

    It 'ON: an order with no network member is not written at all' {
        Use-Boxes $LENOVO_STORED $LENOVO_STORED
        Invoke-BootOrderEnforcement -Manufacturer 'LENOVO' -Enforce $true -CheckMode $false | Out-Null
        Should -Invoke Set-LenovoBootOrder -Times 0 -Exactly
    }
}
