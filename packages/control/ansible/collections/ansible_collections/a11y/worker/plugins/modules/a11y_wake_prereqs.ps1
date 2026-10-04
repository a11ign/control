#!powershell

# The two wake prerequisites a11y_nic_power cannot see: the machine's FIRMWARE Wake-on-LAN, and the adapter's
# IP configuration (#3230). Both are READS that fail by name; the repairs are the smallest that the read can
# then prove.
#
# ## Firmware Wake-on-LAN is not a console visit on a Lenovo
#
# The fleet's header once said firmware WoL "cannot be automated" because the box is off and has no OS to
# ask. That is true of a box that is off and wrong of one that is being provisioned: it is running, and
# Lenovo exposes its BIOS to the installed OS through `root\wmi` (`Lenovo_BiosSetting` to read,
# `Lenovo_SetBiosSetting` and `Lenovo_SaveBiosSettings` to write). So on a Lenovo the value is read, and a
# `Disabled` is repaired or failed by name.
#
# The value is `Primary`, and an `Automatic` is REPAIRED to it, not left alone. This module once left
# `Automatic` alone because worker 4 had woken on it, and it wrote `Automatic` as the value "proved to wake a
# box". #3250's proof cycle (2026-10-04, 12:18-12:19Z) reversed that: worker 6 woke onto its reserved address in
# about 37 s with `Primary` and the PXE host running, where #3241's cycle under `Automatic` failed. `Automatic`
# selects the network-first automatic boot sequence (wake.yml), so a woken box goes to the network rather than
# through the stored order; `Primary` wakes through the stored order. The chairman ruled `Primary` on every
# Lenovo (2026-10-04, #3457), so a provisioned or re-imaged worker no longer comes back to `Automatic`.
#
# The write is refused, by name, for a value the firmware does not list in its `[Optional:...]` set: a write the
# BIOS would reject is not attempted, and a box whose firmware has no `Primary` is a fault to read, not a guess.
#
# A box that is not a Lenovo, or whose WMI classes are absent, reports `not-read` / `unreadable` with the
# reason. It never reports `ok` for a setting this module did not read, and it does not fail: a Realtek box
# that has no Lenovo BIOS is not a box with a fault, it is a box this read cannot speak for.
#
# ## An alternate or static address is how a worker comes up where nobody is looking
#
# Worker 6 came up at the wrong address because the adapter held a static or fallback configuration rather
# than DHCP's reserved one. Every IPv4 address on the adapter whose origin is not DHCP (`Manual`, or the
# `WellKnown` 169.254 link-local a failed lease produces) is reported BY NAME and removed, and the interface
# is returned to DHCP. Read AFTER removal, so `ok` means the adapter was read clean.
#
# Removing the address the play is connected over can drop the connection, exactly as the wake-property
# task in bespoke.yml does; the role bounds that task with a timeout rather than letting it hang.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        interface          = @{ type = 'str'; default = '*' }
        firmware_wol_value = @{ type = 'str'; default = 'Primary' }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$LENOVO_NAMESPACE = 'root\wmi'

# "Wake on LAN,Automatic;[Optional:Disabled,Automatic,Primary]" -> the item, its CURRENT value and the values the
# firmware ADVERTISES for it. $null for a line that is not of the shape, never an empty string that reads as a
# value. Options is empty when the line advertises none, which is not the same as advertising the current one.
function ConvertFrom-LenovoBiosSetting {
    param([string] $CurrentSetting)
    if ($CurrentSetting -notmatch '^(?<item>[^,;]+),(?<value>[^;]*)') { return $null }
    $item = $Matches.item.Trim()
    $value = $Matches.value.Trim()
    $options = @()
    if ($CurrentSetting -match '\[Optional:(?<options>[^\]]*)\]') {
        $options = @($Matches.options -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    return [pscustomobject]@{ Item = $item; Value = $value; Options = $options }
}

# The firmware reading, decided from what was read rather than from what was expected:
#   read        a Lenovo whose Wake-on-LAN item was found and parsed; Value says what it holds and
#               Options what the firmware advertises for it
#   not-read    not a Lenovo, so its firmware cannot be read this way (not a fault)
#   unreadable  a Lenovo whose class or item is absent, with the reason (said, never "ok")
function Get-FirmwareWolState {
    param([string] $Manufacturer, [object[]] $Settings, [string] $ReadError)
    if ($Manufacturer -notmatch 'LENOVO') {
        return [pscustomobject]@{ Status = 'not-read'; Value = $null; Options = @(); Reason = "manufacturer is '$Manufacturer', not Lenovo" }
    }
    if ($ReadError) {
        return [pscustomobject]@{ Status = 'unreadable'; Value = $null; Options = @(); Reason = "Lenovo_BiosSetting could not be read: $ReadError" }
    }
    # `Wake on LAN` on ThinkCentre, `WakeOnLAN` on some ThinkPad firmware. Inside the function so a test that
    # loads only the function sees the same pattern the module runs.
    $item = @($Settings | ForEach-Object { ConvertFrom-LenovoBiosSetting $_.CurrentSetting } |
        Where-Object { $_ -and $_.Item -match '^(Wake on LAN|WakeOnLAN)$' }) | Select-Object -First 1
    if (-not $item) {
        return [pscustomobject]@{ Status = 'unreadable'; Value = $null; Options = @(); Reason = 'Lenovo_BiosSetting has no Wake on LAN item' }
    }
    return [pscustomobject]@{ Status = 'read'; Value = $item.Value; Options = @($item.Options); Reason = $null }
}

function Read-FirmwareWol {
    $maker = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue).Manufacturer
    $settings = $null
    $err = $null
    if ("$maker" -match 'LENOVO') {
        try { $settings = @(Get-CimInstance -Namespace $LENOVO_NAMESPACE -ClassName Lenovo_BiosSetting -ErrorAction Stop) }
        catch { $err = $_.Exception.Message }
    }
    return Get-FirmwareWolState -Manufacturer $maker -Settings $settings -ReadError $err
}

# Lenovo's two-step write: set, then save. The `return` of each is the BIOS's own word ("Success", or
# "Access Denied" when a supervisor password is set), and either one failing is a failure by name.
function Set-FirmwareWol {
    param([string] $Value)
    $set = Get-CimInstance -Namespace $LENOVO_NAMESPACE -ClassName Lenovo_SetBiosSetting |
        Invoke-CimMethod -MethodName SetBiosSetting -Arguments @{ parameter = "Wake on LAN,$Value" }
    if ($set.return -ne 'Success') { throw "SetBiosSetting answered '$($set.return)'" }
    $save = Get-CimInstance -Namespace $LENOVO_NAMESPACE -ClassName Lenovo_SaveBiosSettings |
        Invoke-CimMethod -MethodName SaveBiosSettings -Arguments @{ parameter = '' }
    if ($save.return -ne 'Success') { throw "SaveBiosSettings answered '$($save.return)'" }
}

# Bring the firmware value to Target, and say what happened. Returns the sentence for `changed` (or $null), the
# failures, and the firmware as last read. Three ways to leave it alone: not a Lenovo reading (nothing was read,
# so nothing is repaired), already Target, or -CheckMode. A Target the firmware does not advertise is a failure
# and is NOT written. The read-back after the write is what makes the repair a fact rather than an intention.
function Repair-FirmwareWol {
    param([object] $Firmware, [string] $Target, [switch] $CheckMode)
    $result = [pscustomobject]@{ Changed = $null; Failures = @(); Firmware = $Firmware }
    if ($Firmware.Status -ne 'read' -or $Firmware.Value -eq $Target) { return $result }
    $from = $Firmware.Value
    if ($Firmware.Options -notcontains $Target) {
        $advertised = if ($Firmware.Options.Count -gt 0) { $Firmware.Options -join ', ' } else { 'no options' }
        $result.Failures = @("$env:COMPUTERNAME firmware Wake on LAN is $from and '$Target' is not a value the firmware " +
            "advertises ($advertised), so it was NOT written")
        return $result
    }
    $result.Changed = "firmware Wake on LAN: $from -> $Target"
    if ($CheckMode) { return $result }
    try { Set-FirmwareWol -Value $Target }
    catch {
        $result.Failures = @("$env:COMPUTERNAME firmware Wake on LAN is $from and could NOT be repaired: $($_.Exception.Message)")
        return $result
    }
    $result.Firmware = Read-FirmwareWol
    if ($result.Firmware.Value -ne $Target) {
        $result.Failures = @("$env:COMPUTERNAME firmware Wake on LAN reads '$($result.Firmware.Value)' after the repair, not $Target")
    }
    return $result
}

# Every address on this adapter that DHCP did not hand out, as objects the caller can name and remove.
# Empty is a reading: it was asked for and nothing non-DHCP answered. The property is IPAddress, not Address:
# `$list.Address` on an ARRAY resolves to the array's own Address(int) method instead of enumerating.
function Get-NonDhcpAddress {
    param([int] $InterfaceIndex)
    return @(Get-NetIPAddress -InterfaceIndex $InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.PrefixOrigin -ne 'Dhcp' } |
        ForEach-Object { [pscustomobject]@{ IPAddress = "$($_.IPAddress)"; Origin = "$($_.PrefixOrigin)" } })
}

# One sentence per thing wrong, naming the adapter; empty is clean.
function Get-IpConfigurationProblem {
    param([string] $AdapterName, [int] $InterfaceIndex)
    $problems = [System.Collections.Generic.List[string]]::new()
    $dhcp = (Get-NetIPInterface -InterfaceIndex $InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop).Dhcp
    if ("$dhcp" -ne 'Enabled') { $problems.Add("'$AdapterName' has DHCP $dhcp (a static configuration)") }
    foreach ($a in Get-NonDhcpAddress -InterfaceIndex $InterfaceIndex) {
        $problems.Add("'$AdapterName' holds $($a.IPAddress), origin $($a.Origin), not one DHCP handed out")
    }
    return $problems.ToArray()
}

$adapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'Up' -and ($module.Params.interface -eq '*' -or $_.Name -like $module.Params.interface) })
# Same finding a11y_nic_power makes: reading nothing and reporting ok is how a box goes unwatched.
if ($adapters.Count -eq 0) {
    $module.FailJson("no physical network adapter is Up matching '$($module.Params.interface)' -- " +
        "the wake prerequisites were NOT read")
}

$failures = [System.Collections.Generic.List[string]]::new()
$changed = [System.Collections.Generic.List[string]]::new()

$firmware = Read-FirmwareWol
$wol = Repair-FirmwareWol -Firmware $firmware -Target $module.Params.firmware_wol_value -CheckMode:$module.CheckMode
$firmware = $wol.Firmware
if ($wol.Changed) { $changed.Add($wol.Changed) }
$failures.AddRange([string[]]@($wol.Failures))

foreach ($a in $adapters) {
    $problems = @(Get-IpConfigurationProblem -AdapterName $a.Name -InterfaceIndex $a.ifIndex)
    if ($problems.Count -eq 0) { continue }
    $changed.AddRange([string[]]$problems)
    if ($module.CheckMode) { continue }
    Set-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -Dhcp Enabled -ErrorAction Stop
    foreach ($addr in Get-NonDhcpAddress -InterfaceIndex $a.ifIndex) {
        Remove-NetIPAddress -InterfaceIndex $a.ifIndex -IPAddress $addr.IPAddress -Confirm:$false -ErrorAction Stop
    }
    # The readback is what makes the removal a fact rather than an intention.
    $left = @(Get-IpConfigurationProblem -AdapterName $a.Name -InterfaceIndex $a.ifIndex)
    if ($left.Count -gt 0) { $failures.Add("$env:COMPUTERNAME IP configuration NOT clean after removal: " + ($left -join '; ')) }
}

$module.Result.changed = $changed.Count -gt 0
$module.Result.repaired = $changed.ToArray()
$module.Result.firmware_status = $firmware.Status
$module.Result.firmware_wake_on_lan = $firmware.Value
$module.Result.firmware_reason = $firmware.Reason
$module.Result.failures = $failures.ToArray()
if ($failures.Count -gt 0) {
    $module.FailJson("$env:COMPUTERNAME wake prerequisites did NOT verify: " + ($failures -join '; '))
}
$module.ExitJson()
