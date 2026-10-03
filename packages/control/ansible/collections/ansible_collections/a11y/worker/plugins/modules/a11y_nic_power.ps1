#!powershell

# Stop Windows powering the network adapter down -- WITHOUT stopping it waking the machine.
#
# The SECOND of two mechanisms, and fixing only one leaves the fault intermittent: the sleep timers put
# the whole machine away (see a11y_power_timeouts), while the NIC's own selective suspend powers the
# adapter down with the OS still running. That second one is what produced 48 consecutive EHOSTUNREACH
# failures on the first physical worker, followed by a successful curl thirty seconds later.
#
# ## Those are TWO checkboxes, and conflating them breaks Wake-on-LAN
#
# The adapter's power page has two independent settings: "allow the computer to turn off this device"
# and "allow this device to wake the computer". This fleet wants the first OFF and the second ON -- the
# NIC must stay up while the machine runs, and must still be able to wake it, because the boxes are
# meant to be powered down between runs.
#
# The registry fallback originally wrote PnPCapabilities = 24, which Microsoft documents as preventing
# Windows from turning the adapter off *or letting it wake the computer from standby*. That is BOTH
# checkboxes, so on any box where the cmdlet was missing it would have made Wake-on-LAN impossible while
# reporting success. 8 disables power-down alone and leaves wake armed.
#
# The cmdlet route is preferred precisely because it can express the two independently; the registry
# fallback cannot say "magic packet only", which is recorded rather than hidden.
#
# ## A THIRD arming, the one that stopped worker 4, and a module that reported `ok` over it (#3230)
#
# `Set-NetAdapterPowerManagement -WakeOnMagicPacket` is the ADAPTER's own property. Windows keeps a
# separate, device-level record -- Device Manager's "Allow this device to wake the computer", which
# `powercfg /devicequery wake_armed` lists -- and DISARMS it at every shutdown when it is unticked. On worker 4
# the firmware was on and the adapter property was on and that box still could not be woken, so this module
# could report `ok` on a machine that was never going to come back. It now sets it (`powercfg
# /deviceenablewake`) and READS IT BACK, and a worker that is still not listed fails the play by name: the
# readback is the done-when, a task that ran the enable and did not read is the defect again.
#
# A worker is `wake-armed, UNPROVEN` here and never more. Arming says Windows will honour a packet; only a
# real power cycle (fleet-wake.mjs's `woken` outcome) says the box comes back, and provisioning cannot power
# a box off mid-play, so it names what is still owed instead of claiming it.

#AnsibleRequires -CSharpUtil Ansible.Basic

$spec = @{
    options = @{
        interface   = @{ type = 'str'; default = '*' }
        wake_on_lan = @{ type = 'bool'; default = $true }
    }
    supports_check_mode = $true
}
$module = [Ansible.Basic.AnsibleModule]::Create($args, $spec)

$NIC_CLASS = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}'
# 8  = "allow the computer to turn off this device" unchecked; wake still armed.
# 24 = that PLUS "allow this device to wake the computer" unchecked, which kills Wake-on-LAN.
$DISABLE_POWER_DOWN = 8
$DISABLE_POWER_DOWN_AND_WAKE = 24

# NDIS standard keywords, which -- unlike the display names bespoke.yml sets the same properties by -- do not
# change with the Windows display language or the driver build. `Required` is whether an adapter that does not
# expose the keyword CANNOT do the thing: no magic-packet keyword means no magic-packet wake, while a driver
# with no pattern-wake or EEE keyword has nothing on that needs turning off.
$WAKE_PROPERTIES = @(
    @{ Keyword = '*WakeOnMagicPacket'; Want = '1'; Required = $true }
    @{ Keyword = '*WakeOnPattern';     Want = '0'; Required = $false }
    @{ Keyword = '*EEE';               Want = '0'; Required = $false }
)
# What `powercfg /h off` writes. Read from the registry rather than from hiberfil.sys, which is how
# a11y_power_timeouts decides: a readback through the writer's own instrument cannot disagree with it.
$HIBERNATE_KEY = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'

# The device names Windows will actually let wake the machine, as `powercfg` prints them, one per line.
# A failed powercfg is a THROW, not an empty list: an empty list reads as "nothing is armed" and a failed read
# says nothing about whether anything is.
function Get-WakeArmedDevice {
    $lines = @(& powercfg.exe /devicequery wake_armed 2>&1)
    if ($LASTEXITCODE) {
        throw "powercfg /devicequery wake_armed exited $LASTEXITCODE -- the armed list was NOT read: $($lines -join ' ')"
    }
    return @($lines | ForEach-Object { "$_".Trim() } | Where-Object { $_ -and $_ -ne 'NONE' })
}

function Test-WakeArmed {
    param([string] $DeviceName)
    # -contains is case-insensitive, matching how Device Manager names are compared elsewhere.
    return @(Get-WakeArmedDevice) -contains $DeviceName
}

# One verdict per wanted keyword: ok / wrong / not-exposed / unreadable. Status is never inferred from a
# property that was not read -- a box without the NetAdapter cmdlets is `unreadable`, which fails.
function Get-WakePropertyVerdict {
    param([string] $AdapterName, [object[]] $Wanted)
    if (-not (Get-Command Get-NetAdapterAdvancedProperty -ErrorAction SilentlyContinue)) {
        return @($Wanted | ForEach-Object { [pscustomobject]@{ Keyword = $_.Keyword; Status = 'unreadable'; Got = $null; Required = $_.Required } })
    }
    return @($Wanted | ForEach-Object {
        $p = Get-NetAdapterAdvancedProperty -Name $AdapterName -RegistryKeyword $_.Keyword -ErrorAction SilentlyContinue
        $got = if ($p) { "$(@($p.RegistryValue)[0])" } else { $null }
        $status = if (-not $p) { 'not-exposed' } elseif ($got -eq $_.Want) { 'ok' } else { 'wrong' }
        [pscustomobject]@{ Keyword = $_.Keyword; Status = $status; Got = $got; Required = $_.Required }
    })
}

# $null when the value cannot be read, which is NOT the same fact as "hibernation is off".
function Get-HibernateEnabled {
    $v = (Get-ItemProperty -Path $HIBERNATE_KEY -Name HibernateEnabled -ErrorAction SilentlyContinue).HibernateEnabled
    if ($null -eq $v) { return $null }
    return [int]$v
}

# Everything that stops THIS adapter being woken, as sentences that name it. Empty means armed AND verified:
# every line is a thing that was read, never a thing that was merely set.
function Get-WakeFailure {
    param([object] $Adapter, [object[]] $Wanted)
    $problems = [System.Collections.Generic.List[string]]::new()
    if (-not (Test-WakeArmed $Adapter.InterfaceDescription)) {
        $problems.Add("'$($Adapter.Name)' ('$($Adapter.InterfaceDescription)') is NOT in powercfg /devicequery wake_armed " +
            "after powercfg /deviceenablewake -- Windows will disarm Wake-on-LAN at shutdown")
    }
    foreach ($v in Get-WakePropertyVerdict -AdapterName $Adapter.Name -Wanted $Wanted) {
        $bad = switch ($v.Status) {
            'wrong'       { "reads $($v.Got)" }
            'unreadable'  { 'could NOT be read (no NetAdapter advanced-property cmdlet)' }
            'not-exposed' { if ($v.Required) { 'is not exposed by this driver' } }
        }
        if ($bad) { $problems.Add("'$($Adapter.Name)' $($v.Keyword) $bad") }
    }
    return $problems.ToArray()
}

# Machine-level, not per adapter: Fast Startup (which hibernation off disables) keeps many boards out of S5.
function Get-HibernateFailure {
    $h = Get-HibernateEnabled
    if ($null -eq $h) { return "HibernateEnabled could NOT be read from $HIBERNATE_KEY" }
    if ($h -ne 0) { return "hibernation is ON (HibernateEnabled=$h), so Fast Startup can keep the box out of S5" }
    return $null
}

$adapters = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'Up' -and ($module.Params.interface -eq '*' -or $_.Name -like $module.Params.interface) })

# No adapter Up is a FINDING, not a no-op: this module exists because the network vanishes, and reporting
# ok having adjusted nothing is how that goes unnoticed.
if ($adapters.Count -eq 0) {
    $module.FailJson("no physical network adapter is Up matching '$($module.Params.interface)' -- " +
        "NIC power saving was NOT adjusted, and this box is the kind that goes unreachable")
}

$changed = [System.Collections.Generic.List[string]]::new()
$byRegistry = [System.Collections.Generic.List[string]]::new()

foreach ($a in $adapters) {
    $already = $false
    $wantWake = if ($module.Params.wake_on_lan) { 'Enabled' } else { 'Disabled' }
    try {
        $state = Get-NetAdapterPowerManagement -Name $a.Name -ErrorAction Stop
        # Both settings, checked independently -- the whole reason the cmdlet route is preferred.
        $already = ($state.AllowComputerToTurnOffDevice -eq 'Disabled' -and $state.WakeOnMagicPacket -eq $wantWake)
        if (-not $already -and -not $module.CheckMode) {
            Set-NetAdapterPowerManagement -Name $a.Name -AllowComputerToTurnOffDevice Disabled -WakeOnMagicPacket $wantWake -ErrorAction Stop
            # Pattern wake would bring the box up for ordinary broadcast traffic, which on a fleet meant
            # to be off between runs is the difference between "asleep" and "always on".
            if ($module.Params.wake_on_lan) {
                Set-NetAdapterPowerManagement -Name $a.Name -WakeOnPattern Disabled -ErrorAction SilentlyContinue
            }
        }
    } catch {
        # This SKU has no power-management cmdlet. Fall back to the registry value it would have written.
        $byRegistry.Add($a.Name)
        $key = Get-ChildItem $NIC_CLASS -ErrorAction SilentlyContinue | Where-Object {
            (Get-ItemProperty $_.PSPath -Name DriverDesc -ErrorAction SilentlyContinue).DriverDesc -eq $a.InterfaceDescription
        }
        if (-not $key) {
            $module.FailJson("adapter '$($a.Name)' has no power-management cmdlet AND no matching registry " +
                "key under the network class -- neither mechanism is available, so it WILL power down")
        }
        $want = if ($module.Params.wake_on_lan) { $DISABLE_POWER_DOWN } else { $DISABLE_POWER_DOWN_AND_WAKE }
        foreach ($k in $key) {
            $current = (Get-ItemProperty $k.PSPath -Name PnPCapabilities -ErrorAction SilentlyContinue).PnPCapabilities
            $already = ($current -eq $want)
            if (-not $already -and -not $module.CheckMode) {
                Set-ItemProperty $k.PSPath -Name PnPCapabilities -Value $want -Type DWord -Force
            }
        }
    }
    if (-not $already) { $changed.Add($a.Name) }
}

# Arm the DEVICE, then read it back. This sits after the loop because the loop's `Set-NetAdapterPowerManagement`
# re-initialises the adapter, and a readback taken before that settles would be a reading of the old state.
$wakeFailures = [System.Collections.Generic.List[string]]::new()
if ($module.Params.wake_on_lan) {
    foreach ($a in $adapters) {
        if (-not (Test-WakeArmed $a.InterfaceDescription)) {
            if ($changed -notcontains $a.Name) { $changed.Add($a.Name) }
            if (-not $module.CheckMode) { & powercfg.exe /deviceenablewake $a.InterfaceDescription | Out-Null }
        }
        # Check mode changed nothing, so a verdict on it would only report its own abstention as a fault.
        if (-not $module.CheckMode) { $wakeFailures.AddRange([string[]]@(Get-WakeFailure -Adapter $a -Wanted $WAKE_PROPERTIES)) }
    }
    $hibernateFailure = Get-HibernateFailure
    if ($hibernateFailure -and -not $module.CheckMode) { $wakeFailures.Add($hibernateFailure) }
}

$module.Result.changed = $changed.Count -gt 0
$module.Result.adjusted = $changed.ToArray()
$module.Result.adapters = @($adapters | ForEach-Object { $_.Name })
$module.Result.via_registry = $byRegistry.ToArray()
$module.Result.wake_failures = $wakeFailures.ToArray()
# ARMED is a reading; PROVEN needs a power cycle this play cannot perform. Never `ok` on the arming alone.
$module.Result.wake_proof = 'UNPROVEN'
$module.Result.wake_report = "$env:COMPUTERNAME wake-armed, UNPROVEN -- a real cycle (box off, one magic packet, /health 200) is still owed"
if ($wakeFailures.Count -gt 0) {
    $module.FailJson("$env:COMPUTERNAME CANNOT BE WOKEN -- wake arming did NOT verify: " + ($wakeFailures -join '; '))
}
$module.ExitJson()
