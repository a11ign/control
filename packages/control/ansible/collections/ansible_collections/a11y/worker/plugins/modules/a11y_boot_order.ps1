#!powershell

# Takes network boot out of a worker's firmware BOOT ORDER, on a Lenovo and on an HP, and reads the stored
# order back by name (#3387). Network boot is how a PXE server on the workers' LAN can take a boot:
# `autounattend.xml` is served over PXE and its `WillWipeDisk` makes the install hands-off, so a box that tries
# Network before its disk can be re-imaged by whatever answers.
#
# ## Names and values come from the BOX, never from a typed list
#
# A firmware setting's name and its allowed values differ by model and BIOS revision, and a wrong firmware
# write on fifteen boxes is not a revert. So the module writes only a value it derived from the members IT
# read for a setting IT found by name, and reads the stored value back after the save. A setting it cannot
# find is `unreadable` with the reason and the item names it DID see, never `ok`.
#
# The target is the box's own current order with its network members taken out of play: on Lenovo REMOVED, a
# subset of what was read in the order it was read; on HP MARKED `(Disabled)` in place, because HP's ordered
# list only applies a value that carries every member (below). Never a member the box did not list. It is
# refused when it would leave nothing enabled to boot from.
#
# ## The module's `enforce` defaults to false; the ROLE turns it on
#
# `enforce` defaults to false, and with it false the module READS and reports and calls no setter. The role's
# `worker_enforce_boot_order` was false while #3388 ran this on 13 workers by hand and #3400 and #3389 wrote the
# other two; it is true since #3492, so `fleet:provision` passes `enforce: true`. `-e worker_enforce_boot_order=false`
# is how to read without writing.
#
# ## Wake on LAN is READ beside the boot order, and NEVER rewritten
#
# Lenovo's `Wake on LAN: Automatic` selects a boot sequence that starts with Network regardless of the stored
# order (wake.yml), so an order without Network may not hold on a woken box. `Primary` wakes through the
# stored order. The result says whether the sequence a wake uses was SHOWN to omit Network; where it was not,
# the status is `order-set` (and the reason says why), never `ok`.
#
# ## The cross-vendor read, and the rebuild path
#
# `bcdedit /enum firmware` lists the UEFI entries a box will try. It is the second reading beside the vendor
# setting, because a firmware that rebuilds its own order at boot can make the two disagree. It is also what
# says whether a network ENTRY remains addressable for a one-time `BootNext`, the path os-rollback.yml and a
# PXE rebuild rely on. This module removes network from the ORDER and never deletes an entry.
#
# ## What this does not claim
#
# The SETTING, not the behaviour: "boot order set and read back". No test here boots a box with a PXE server
# answering, because that test would run `autounattend.xml`'s disk wipe.
#
# ## What was read on an HP box (#3404, worker 7, HP ProDesk 600 G4 DM, BIOS Q22 02.33.00)
#
# The census read ten HP workers: `UEFI Boot Order`, `IsReadOnly 0`, `Size 4`, stored
# `HDD:M.2:1,HDD:USB:1,NETWORK IPV4:EMBEDDED:1,NETWORK IPV6:EMBEDDED:1`. On worker 7, `SetBIOSSetting` answered 0 for
# a two-member value (the disks only) and the list was UNCHANGED: an ordered list is applied only when the value
# carries ALL its members, and a short one is accepted and ignored. A full-length value applies at once with no
# restart, whether permuted or with the network members marked `(Disabled)`, the suffix the box itself prints on
# `Legacy Boot Order` (`<no legacy boot options available>(Disabled)`). So the HP write sends every member and
# marks the network ones; it is not a removal.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        enforce = @{ type = 'bool'; default = $false }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$LENOVO_NAMESPACE = 'root\wmi'
$HP_NAMESPACE = 'root\HP\InstrumentedBIOS'

# Which firmware dialect to speak. $null is a box this module cannot speak for, not a fault.
function Get-BootVendor {
    param([string] $Manufacturer)
    if ($Manufacturer -match 'LENOVO') { return 'Lenovo' }
    if ($Manufacturer -match '^(HP|Hewlett)') { return 'HP' }
    return $null
}

# A boot-order MEMBER that reaches the network. Case-insensitive, and deliberately broad: a member this misses
# stays in the order and the read-back says so, while one it over-matches is only removed from the order.
function Test-NetworkBootMember {
    param([string] $Member)
    return $Member -match 'network|pxe|\blan\b|ipv?[46]|ethernet|\bnic\b|http'
}

# The box's own order minus its network members, in the order it was read. Never a member that was not read.
function Get-BootOrderTarget {
    param([string[]] $Members)
    return @($Members | Where-Object { -not (Test-NetworkBootMember $_) })
}

# HP marks a member off with a `(Disabled)` suffix and keeps it in the list (see the header).
function Test-DisabledBootMember {
    param([string] $Member)
    return $Member -match '\(Disabled\)$'
}

# HP's target: every member the box listed, in the order it listed them, with each still-enabled network member
# marked `(Disabled)`. The same length as the read, because a shorter value is accepted and ignored.
function Get-HpBootOrderTarget {
    param([string[]] $Members)
    return @($Members | ForEach-Object {
        if ((Test-NetworkBootMember $_) -and -not (Test-DisabledBootMember $_)) { "$_(Disabled)" } else { $_ }
    })
}

function Test-SameMembers {
    param([string[]] $Left, [string[]] $Right)
    $l = @($Left)
    $r = @($Right)
    if ($l.Count -ne $r.Count) { return $false }
    for ($i = 0; $i -lt $l.Count; $i++) { if ($l[$i] -cne $r[$i]) { return $false } }
    return $true
}

# "Primary Boot Sequence,PCI LAN:Hard Drive;[Optional:...]" -> item, current value, and the value split into
# members. A value with no ':' is one member, so an enumerated setting ("Wake on LAN,Automatic") is not
# mistaken for an order by anything that checks Members.Count. $null for a line not of the shape.
function ConvertFrom-LenovoBootSetting {
    param([string] $CurrentSetting)
    if ($CurrentSetting -notmatch '^(?<item>[^,;]+),(?<value>[^;]*)') { return $null }
    $value = $Matches.value.Trim()
    $members = @($value -split ':' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    return [pscustomobject]@{ Item = $Matches.item.Trim(); Value = $value; Members = $members }
}

# Names a person pasting a first read needs: every item that could be a boot item, so a miss is diagnosable.
function Get-BootItemName {
    param([string[]] $Names)
    return @($Names | Where-Object { $_ -match 'boot|sequence|startup|network|pxe|lan' })
}

# The Lenovo reading, decided from what was read:
#   read        the boot-order item was found by name and parsed into members
#   unreadable  the class could not be read, or no item looks like a boot order (ItemsSeen says what was there)
# `Wake on LAN` and the `Automatic Boot Sequence` item are read beside it: they decide which sequence a wake uses.
function Get-LenovoBootState {
    param([object[]] $Settings, [string] $ReadError)
    $none = [pscustomobject]@{ Status = 'unreadable'; Setting = $null; Members = @(); Reason = $null
        ItemsSeen = @(); WakeOnLan = $null; AutomaticMembers = $null }
    if ($ReadError) {
        $none.Reason = "Lenovo_BiosSetting could not be read: $ReadError"
        return $none
    }
    $parsed = @($Settings | ForEach-Object { ConvertFrom-LenovoBootSetting $_.CurrentSetting } | Where-Object { $_ })
    $none.ItemsSeen = @(Get-BootItemName ($parsed | ForEach-Object { $_.Item }))
    $order = $parsed | Where-Object { $_.Item -match '^(Primary Boot Sequence|Boot Order|BootOrder|Boot Sequence)$' } |
        Select-Object -First 1
    if (-not $order) {
        $none.Reason = 'Lenovo_BiosSetting has no boot-order item (Primary Boot Sequence / Boot Order / BootOrder / Boot Sequence)'
        return $none
    }
    if ($order.Members.Count -lt 2) {
        $none.Reason = "'$($order.Item)' reads '$($order.Value)', which is not an ordered list of two or more members"
        return $none
    }
    $wol = $parsed | Where-Object { $_.Item -match '^(Wake on LAN|WakeOnLAN)$' } | Select-Object -First 1
    $auto = $parsed | Where-Object { $_.Item -eq 'Automatic Boot Sequence' } | Select-Object -First 1
    return [pscustomobject]@{ Status = 'read'; Setting = $order.Item; Members = $order.Members; Reason = $null
        ItemsSeen = $none.ItemsSeen; WakeOnLan = $(if ($wol) { $wol.Value }); AutomaticMembers = $(if ($auto) { $auto.Members }) }
}

# `bcdedit /enum firmware` text -> the entries the firmware lists, in the order it will try them. Blocks are
# separated by a blank line; a value that wraps (`displayorder` lists one id per line) continues on lines
# that start with whitespace. Localised bcdedit output is not parsed and reads `unreadable`.
function Get-FirmwareBootEntryState {
    param([string] $BcdeditText, [string] $ReadError)
    $unread = { param($why) [pscustomobject]@{ Status = 'unreadable'; Reason = $why; Entries = @(); Order = @()
        NetworkEntries = @(); NetworkInOrder = $false } }
    if ($ReadError) { return & $unread "bcdedit /enum firmware failed: $ReadError" }
    $entries = [System.Collections.Generic.List[object]]::new()
    $orderIds = @()
    foreach ($block in ($BcdeditText -split '(?:\r?\n){2,}')) {
        $fields = @{}
        $key = $null
        foreach ($line in ($block -split '\r?\n')) {
            if ($line -match '^(?<k>[A-Za-z]\S*)\s+(?<v>.+)$') { $key = $Matches.k; $fields[$key] = @($Matches.v.Trim()) }
            elseif ($key -and $line -match '^\s+(?<v>\S.*)$') { $fields[$key] += $Matches.v.Trim() }
        }
        if ($fields.identifier -eq '{fwbootmgr}') { $orderIds = @($fields.displayorder) }
        elseif ($fields.identifier -and $fields.description) {
            $entries.Add([pscustomobject]@{ Id = "$($fields.identifier)"; Description = "$($fields.description)" })
        }
    }
    if ($entries.Count -eq 0 -and $orderIds.Count -eq 0) {
        return & $unread 'bcdedit /enum firmware listed no firmware entries (a legacy BIOS, or output this parser does not read)'
    }
    $names = @{}
    foreach ($e in $entries) { $names[$e.Id] = $e.Description }
    $order = @($orderIds | ForEach-Object { if ($names.ContainsKey($_)) { $names[$_] } else { $_ } })
    $network = @($entries | Where-Object { Test-NetworkBootMember $_.Description } | ForEach-Object { $_.Description })
    return [pscustomobject]@{ Status = 'read'; Reason = $null; Entries = $entries.ToArray(); Order = $order
        NetworkEntries = $network; NetworkInOrder = [bool](@($order | Where-Object { Test-NetworkBootMember $_ }).Count) }
}

# Whether the boot sequence a WAKE uses was SHOWN to omit Network. Shown only from a reading of this box:
#   Lenovo, Wake on LAN Primary     wakes through the stored order, which is the one read back
#   Lenovo, Wake on LAN Automatic   wakes through 'Automatic Boot Sequence', read only if the box lists it
#   anything else (Disabled, unread, HP)   UNREAD
function Get-WakeSequenceState {
    param([string] $Vendor, [string] $WakeOnLan, [string[]] $PrimaryMembers, [string[]] $AutomaticMembers)
    $verdict = {
        param($members, $source)
        if (@($members | Where-Object { Test-NetworkBootMember $_ }).Count -gt 0) {
            return [pscustomobject]@{ State = 'includes-network'; Reason = "$source still lists Network: $($members -join ':')" }
        }
        return [pscustomobject]@{ State = 'omits-network'; Reason = "$source omits Network: $($members -join ':')" }
    }
    if ($Vendor -ne 'Lenovo') {
        return [pscustomobject]@{ State = 'UNREAD'; Reason = "the boot sequence a wake of a '$Vendor' box uses is not read by this module" }
    }
    if ($WakeOnLan -eq 'Primary') { return & $verdict $PrimaryMembers 'the Primary boot sequence a wake uses' }
    if ($WakeOnLan -eq 'Automatic' -and $AutomaticMembers) { return & $verdict $AutomaticMembers "the 'Automatic Boot Sequence' a wake uses" }
    $why = if ($WakeOnLan -eq 'Automatic') { "Wake on LAN is Automatic, whose sequence starts with Network, and the box lists no 'Automatic Boot Sequence' to read" }
           else { "Wake on LAN reads '$WakeOnLan', which does not show what sequence a wake uses" }
    return [pscustomobject]@{ State = 'UNREAD'; Reason = $why }
}

# What to do about a vendor reading. The write guard lives HERE, so it is one place to test and to break:
#   none     the order holds no ENABLED network member (or was not read): nothing to write
#   report   there is a network member and enforcement is off: say so and write nothing
#   write    enforcement is on: Target is the read order with its network members taken out (removed on Lenovo,
#            marked `(Disabled)` on HP)
#   refuse   taking network out would leave nothing enabled to boot from
function Get-BootOrderPlan {
    param([object] $Read, [bool] $Enforce)
    $nothing = [pscustomobject]@{ Action = 'none'; Target = @(); Reason = $null }
    if ($Read.Status -ne 'read') { return $nothing }
    $target = if ($Read.Vendor -eq 'HP') { @(Get-HpBootOrderTarget $Read.Members) } else { @(Get-BootOrderTarget $Read.Members) }
    if (Test-SameMembers $target $Read.Members) { return $nothing }
    $bootable = @($target | Where-Object { -not (Test-NetworkBootMember $_) -and -not (Test-DisabledBootMember $_) })
    if ($bootable.Count -eq 0) {
        return [pscustomobject]@{ Action = 'refuse'; Target = @(); Reason = "every enabled member of '$($Read.Setting)' is a network member ($($Read.Members -join ':')); taking them out would leave nothing to boot from" }
    }
    if (-not $Enforce) {
        return [pscustomobject]@{ Action = 'report'; Target = $target; Reason = "'$($Read.Setting)' lists network boot ($($Read.Members -join ':')) and enforcement is off, so nothing was written" }
    }
    return [pscustomobject]@{ Action = 'write'; Target = $target; Reason = $null }
}

# The one word this run says, from what was read and what the read-back showed. `ok` and `changed` are claimed
# only when NOTHING is left unshown; every caveat is named instead (`order-set`).
#   ok / changed   the stored order omits Network (already / set and read back) and the wake sequence and the
#                  live firmware order agree
#   order-set      the stored order omits Network, but a caveat stands (Reasons says which)
#   needs-change   network is in the order and nothing was written (enforcement off, or check mode)
#   not-read / unreadable   the vendor order was not read (not that vendor / the read failed)
#   failed         the write was refused, or the read-back did not equal the target
function Get-BootOrderVerdict {
    param([object] $Before, [object] $Plan, [object] $After, [string] $WriteError,
          [object] $Wake, [object] $Live, [bool] $CheckMode)
    $say = { param($s, $r) [pscustomobject]@{ Status = $s; Reasons = @($r | Where-Object { $_ }) } }
    if ($Before.Status -ne 'read') { return & $say $(if ($Before.Vendor) { 'unreadable' } else { 'not-read' }) $Before.Reason }
    if ($Plan.Action -eq 'refuse') { return & $say 'failed' $Plan.Reason }
    if ($Plan.Action -eq 'report') { return & $say 'needs-change' $Plan.Reason }
    $changed = $Plan.Action -eq 'write'
    if ($changed -and $CheckMode) { return & $say 'needs-change' "check mode: would set '$($Before.Setting)' to $($Plan.Target -join ':')" }
    if ($changed -and $WriteError) { return & $say 'failed' "writing '$($Before.Setting)' failed: $WriteError" }
    if ($changed -and ($After.Status -ne 'read' -or -not (Test-SameMembers $After.Members $Plan.Target))) {
        return & $say 'failed' "read-back of '$($Before.Setting)' was '$($After.Members -join ':')' ($($After.Reason)), not the target '$($Plan.Target -join ':')'"
    }
    $caveats = @()
    if ($Wake.State -ne 'omits-network') { $caveats += "wake-sequence $($Wake.State): $($Wake.Reason)" }
    if ($Live.Status -ne 'read') { $caveats += "live firmware order UNREAD: $($Live.Reason)" }
    elseif ($Live.NetworkInOrder) { $caveats += "the live firmware order still lists Network ($($Live.Order -join ' > ')); it may only follow the stored order at the next restart" }
    $word = if ($caveats.Count -gt 0) { 'order-set' } elseif ($changed) { 'changed' } else { 'ok' }
    return & $say $word $caveats
}

# What the rebuild path looks like after enforcement: is a network ENTRY still addressable for a one-time
# BootNext? From the live firmware enumeration, which may change at the next restart.
function Get-RebuildPathState {
    param([object] $Live)
    if ($Live.Status -ne 'read') { return [pscustomobject]@{ Addressable = 'UNREAD'; Reason = "the firmware entries were not read: $($Live.Reason)" } }
    if ($Live.NetworkEntries.Count -gt 0) {
        return [pscustomobject]@{ Addressable = 'yes'; Reason = "a network entry remains addressable for a one-time BootNext: $($Live.NetworkEntries -join '; ')" }
    }
    return [pscustomobject]@{ Addressable = 'no'; Reason = 'NO network entry is listed by the firmware: a PXE rebuild of this box is now a console visit' }
}

# The HP reading, from HP's documented BIOS WMI interface and confirmed on worker 7 (#3404; see the header).
# `HP_BIOSOrderedList` carries `Name`, `Value` (the CURRENT order, comma-separated) and `IsReadOnly`; the boot
# lists are named "UEFI Boot Order" and "Legacy Boot Order", and a network member reads like
# "NETWORK IPV4:EMBEDDED:1" (https://developers.hp.com/hp-client-management/doc/understanding-hp-bios-settings).
# Same decision as the Lenovo one: read by name, or unreadable with the names it did see.
function Get-HpBootState {
    param([object[]] $Settings, [string] $ReadError)
    $none = [pscustomobject]@{ Status = 'unreadable'; Setting = $null; Members = @(); Reason = $null
        ItemsSeen = @(); WakeOnLan = $null; AutomaticMembers = $null }
    if ($ReadError) {
        $none.Reason = "HP_BIOSOrderedList could not be read: $ReadError"
        return $none
    }
    $none.ItemsSeen = @($Settings | ForEach-Object { "$($_.Name)" })
    $lists = @($Settings | Where-Object { $_.Name -match '^(UEFI |Legacy )?Boot Order$' })
    $order = @($lists | Where-Object { $_.Name -match '^UEFI' }) + @($lists) | Select-Object -First 1
    if (-not $order) {
        $none.Reason = 'HP_BIOSOrderedList has no boot-order list (UEFI Boot Order / Legacy Boot Order)'
        return $none
    }
    $members = @("$($order.Value)" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($members.Count -lt 2) {
        $none.Reason = "'$($order.Name)' reads '$($order.Value)', which is not an ordered list of two or more members"
        return $none
    }
    if ($order.IsReadOnly -eq 1) {
        $none.Reason = "'$($order.Name)' is read-only (IsReadOnly 1), so SetBIOSSetting cannot change it"
        return $none
    }
    return [pscustomobject]@{ Status = 'read'; Setting = $order.Name; Members = $members; Reason = $null
        ItemsSeen = $none.ItemsSeen; WakeOnLan = $null; AutomaticMembers = $null }
}

function Read-BootOrder {
    param([string] $Manufacturer)
    $vendor = Get-BootVendor $Manufacturer
    if (-not $vendor) {
        return [pscustomobject]@{ Vendor = $null; Status = 'not-read'; Setting = $null; Members = @()
            Reason = "manufacturer is '$Manufacturer', neither Lenovo nor HP"; ItemsSeen = @(); WakeOnLan = $null; AutomaticMembers = $null }
    }
    $settings = $null
    $err = $null
    try {
        if ($vendor -eq 'Lenovo') { $settings = @(Get-CimInstance -Namespace $LENOVO_NAMESPACE -ClassName Lenovo_BiosSetting -ErrorAction Stop) }
        else { $settings = @(Get-CimInstance -Namespace $HP_NAMESPACE -ClassName HP_BIOSOrderedList -ErrorAction Stop) }
    } catch { $err = $_.Exception.Message }
    $state = if ($vendor -eq 'Lenovo') { Get-LenovoBootState -Settings $settings -ReadError $err }
             else { Get-HpBootState -Settings $settings -ReadError $err }
    $state | Add-Member -NotePropertyName Vendor -NotePropertyValue $vendor -PassThru
}

function Read-FirmwareBootEntry {
    $text = $null
    $err = $null
    try { $text = (& bcdedit.exe /enum firmware 2>&1) -join "`n" } catch { $err = $_.Exception.Message }
    if (-not $err -and $LASTEXITCODE -ne 0) { $err = "exit $LASTEXITCODE`: $text" }
    return Get-FirmwareBootEntryState -BcdeditText $text -ReadError $err
}

# Lenovo's two-step write: set, then save. The `return` of each is the BIOS's own word ("Success", or
# "Access Denied" when a supervisor password is set), and either one failing is a failure by name.
function Set-LenovoBootOrder {
    param([string] $Setting, [string[]] $Members)
    $set = Get-CimInstance -Namespace $LENOVO_NAMESPACE -ClassName Lenovo_SetBiosSetting |
        Invoke-CimMethod -MethodName SetBiosSetting -Arguments @{ parameter = "$Setting,$($Members -join ':')" }
    if ($set.return -ne 'Success') { throw "SetBiosSetting answered '$($set.return)'" }
    $save = Get-CimInstance -Namespace $LENOVO_NAMESPACE -ClassName Lenovo_SaveBiosSettings |
        Invoke-CimMethod -MethodName SaveBiosSettings -Arguments @{ parameter = '' }
    if ($save.return -ne 'Success') { throw "SaveBiosSettings answered '$($save.return)'" }
}

# HP's write: HP_BIOSSettingInterface.SetBIOSSetting(Name, Value, Password), an ordered list set as the
# comma-separated order. `Return 0` does NOT mean the value applied: a value missing members answers 0 and
# changes nothing (#3404), which is why the caller's read-back, not this return, decides success. The return codes are HP's own (0 Success, 1 Not Supported, 2 Unspecified Error,
# 3 Timeout, 4 Failed, 5 Invalid Parameter, 6 Access Denied). No BIOS password is held by this repository, so
# none is sent: a box with one answers 6 and that is a failure by name, which is the intended outcome.
function Set-HpBootOrder {
    param([string] $Setting, [string[]] $Members)
    $set = Get-CimInstance -Namespace $HP_NAMESPACE -ClassName HP_BIOSSettingInterface |
        Invoke-CimMethod -MethodName SetBIOSSetting -Arguments @{ Name = $Setting; Value = ($Members -join ','); Password = '' }
    if ($set.Return -ne 0) {
        $word = switch ($set.Return) { 1 { 'Not Supported' } 2 { 'Unspecified Error' } 3 { 'Timeout' } 4 { 'Failed' }
            5 { 'Invalid Parameter' } 6 { 'Access Denied (a BIOS password is set)' } default { 'an unknown code' } }
        throw "SetBIOSSetting answered $($set.Return): $word"
    }
}

# Read, decide, and (only when the plan says write and this is not check mode) write and read back. The ONE
# place a setter is called, so "with enforcement off no setter is called" is a statement about this function.
# A refusal is carried as text, not thrown, so the verdict names it and the module still reports what it read.
function Invoke-BootOrderEnforcement {
    param([string] $Manufacturer, [bool] $Enforce, [bool] $CheckMode)
    $before = Read-BootOrder -Manufacturer $Manufacturer
    $plan = Get-BootOrderPlan -Read $before -Enforce $Enforce
    $run = [pscustomobject]@{ Before = $before; Plan = $plan; After = $before; WriteError = $null }
    if ($plan.Action -ne 'write' -or $CheckMode) { return $run }
    try {
        if ($before.Vendor -eq 'Lenovo') { Set-LenovoBootOrder -Setting $before.Setting -Members $plan.Target }
        else { Set-HpBootOrder -Setting $before.Setting -Members $plan.Target }
    } catch { $run.WriteError = $_.Exception.Message }
    if (-not $run.WriteError) { $run.After = Read-BootOrder -Manufacturer $Manufacturer }
    return $run
}

$maker = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue).Manufacturer
$run = Invoke-BootOrderEnforcement -Manufacturer $maker -Enforce $module.Params.enforce -CheckMode $module.CheckMode
$before = $run.Before
$plan = $run.Plan
$after = $run.After
$writeError = $run.WriteError
# The live firmware order is read AFTER the write, because what is wanted is what the box will try now.
$live = Read-FirmwareBootEntry
$wakeSource = if ($after.Status -eq 'read') { $after } else { $before }
$wake = Get-WakeSequenceState -Vendor $before.Vendor -WakeOnLan $wakeSource.WakeOnLan `
    -PrimaryMembers $wakeSource.Members -AutomaticMembers $wakeSource.AutomaticMembers
$verdict = Get-BootOrderVerdict -Before $before -Plan $plan -After $after -WriteError $writeError `
    -Wake $wake -Live $live -CheckMode $module.CheckMode
$rebuild = Get-RebuildPathState -Live $live

$module.Result.changed = ($plan.Action -eq 'write' -and -not $module.CheckMode -and -not $writeError)
$module.Result.boot_status = $verdict.Status
$module.Result.boot_reasons = @($verdict.Reasons)
$module.Result.enforced = [bool]$module.Params.enforce
$module.Result.vendor = $before.Vendor
$module.Result.manufacturer = "$maker"
$module.Result.boot_setting = $before.Setting
$module.Result.boot_order_before = @($before.Members)
$module.Result.boot_order_after = @($after.Members)
$module.Result.boot_order_target = @($plan.Target)
$module.Result.boot_items_seen = @($before.ItemsSeen)
$module.Result.wake_on_lan = $before.WakeOnLan
$module.Result.wake_sequence = $wake.State
$module.Result.wake_sequence_reason = $wake.Reason
$module.Result.live_firmware_order = @($live.Order)
$module.Result.network_entry_addressable = $rebuild.Addressable
$module.Result.rebuild_path = $rebuild.Reason
if ($verdict.Status -eq 'failed') {
    $module.FailJson("$env:COMPUTERNAME boot order did NOT verify: " + ($verdict.Reasons -join '; '))
}
$module.ExitJson()
