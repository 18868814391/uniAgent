# =============================================================
#  dual-net.ps1 -- Use the corporate Wi-Fi for the intranet AND a
#  second uplink (phone USB tethering) for opencode.ai, at the same time.
#
#  MEASURED (same laptop, same moment):
#     path to Cloudflare via IT Wi-Fi .......   4.6 KB/s  (broken)
#     path to Cloudflare via phone 5G ....... 580   KB/s  (125x faster)
#     path to intranet (wiki/git) ........... only reachable via IT Wi-Fi
#
#  RUN AS ADMINISTRATOR.
#
#  Usage:
#    ... -File scripts\dual-net.ps1
#        Show mode: list adapters, metrics, default routes, target IPs.
#
#    ... -File scripts\dual-net.ps1 -Apply -Outbound huatie5g -Intranet IT
#        RECOMMENDED with a USB Wi-Fi dongle: -Outbound / -Intranet accept a
#        Wi-Fi SSID, an adapter alias, or a description substring. Using SSIDs
#        avoids the localized interface names entirely.
#
#    ... -File scripts\dual-net.ps1 -Apply -DryRun
#        Print the plan and change nothing. Always safe to run first.
#
#    ... -File scripts\dual-net.ps1 -Apply
#        Mode "OpencodeOnly" (DEFAULT, recommended):
#          - keep the intranet NIC as the default gateway (everything normal
#            keeps using it: intranet, domestic sites, low mobile data)
#          - send ONLY opencode.ai (Cloudflare) out through the second NIC
#
#    ... -File scripts\dual-net.ps1 -Apply -Mode PreferOutbound
#        Mode "PreferOutbound":
#          - make the second NIC (phone) the default gateway
#          - route 172.16.0.0/12 back through the intranet NIC
#          - simpler & immune to Cloudflare IP changes, but ALL internet
#            traffic is billed to your mobile data plan
#
#    ... -File scripts\dual-net.ps1 -Undo
#        Remove added routes and restore adapter metrics.
#
#  Nothing else is touched: no MTU, no DNS, no proxy, no firewall.
#  Routes are added to the ACTIVE store only (gone after reboot).
# =============================================================

[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Undo,
    [switch]$DryRun,                      # print the plan, change nothing
    [ValidateSet('OpencodeOnly', 'PreferOutbound')]
    [string]$Mode = 'OpencodeOnly',
    # Leave empty to auto-detect. On a Chinese Windows the aliases are localized
    # (e.g. "Ethernet 3" shows up as a non-ASCII name), so auto-detect is safer:
    #   Outbound  = the RNDIS / Internet-Sharing / tethering adapter
    #   Intranet  = the other Up adapter that owns a default gateway
    [string]$Intranet = '',
    [string]$Outbound = '',
    [string]$Target = 'opencode.ai',
    [string]$CorpPrefix = '172.16.0.0/12',
    [int]$PrefixLen = 32                 # 32 = host routes from live DNS, 24 = whole /24
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Test-NetConnection 的进度条会把输出刷花
$StateFile = Join-Path $env:TEMP 'dual-net-state.json'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Resolve a Wi-Fi SSID -> adapter, without depending on the localized
# interface name. Get-NetConnectionProfile exposes .Name = SSID for wireless.
function Resolve-ByProfileName([string]$want) {
    $profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)
    foreach ($p in $profiles) {
        if ($p.Name -eq $want) { return (Get-NetAdapter -InterfaceIndex $p.InterfaceIndex -ErrorAction SilentlyContinue) }
    }
    foreach ($p in $profiles) {
        if ($p.Name -like "*$want*") { return (Get-NetAdapter -InterfaceIndex $p.InterfaceIndex -ErrorAction SilentlyContinue) }
    }
    return $null
}

# $want can be: a Wi-Fi SSID ("huatie5g"), an adapter alias, or a description substring.
# Leave empty to auto-detect (works for phone USB tethering / RNDIS).
function Resolve-AdapterAlias([string]$want, [string]$excludeAlias = '') {
    $all = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' })
    if ($want) {
        $bySsid = Resolve-ByProfileName $want
        if ($bySsid -and $bySsid.Status -eq 'Up' -and $bySsid.InterfaceAlias -ne $excludeAlias) { return $bySsid }
        foreach ($n in $all) {
            if ($n.InterfaceAlias -eq $excludeAlias) { continue }
            if ($n.InterfaceAlias -eq $want -or $n.InterfaceDescription -eq $want) { return $n }
        }
        foreach ($n in $all) {
            if ($n.InterfaceAlias -eq $excludeAlias) { continue }
            if ($n.InterfaceAlias -like "*$want*" -or $n.InterfaceDescription -like "*$want*") { return $n }
        }
        return $null
    }
    # auto-detect the tethering adapter
    foreach ($n in $all) {
        if ($n.InterfaceDescription -match 'RNDIS|Internet Sharing|Tether|iPhone|Android|Mobile' -or
            $n.InterfaceAlias -match 'RNDIS|Internet Sharing|Tether') {
            if ($n.InterfaceAlias -ne $excludeAlias) { return $n }
        }
    }
    return $null
}

# Every Up adapter that owns a default gateway (= a real uplink), virtual ones excluded.
function Get-UplinkCandidates {
    Get-NetAdapter | Where-Object {
        $_.Status -eq 'Up' -and
        $_.InterfaceDescription -notmatch 'Virtual|Wi-Fi Direct|TAP|Loopback|Bluetooth|VPN' -and
        (Get-NetRoute -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)
    }
}

function Resolve-IntranetAlias([string]$excludeAlias) {
    $withGw = @(Get-UplinkCandidates | Where-Object { $_.InterfaceAlias -ne $excludeAlias })
    if ($withGw.Count -eq 1) { return $withGw[0] }
    if ($withGw.Count -gt 1) {
        # ambiguous: prefer the one already carrying the intranet connection profile, else lowest index
        return ($withGw | Sort-Object ifIndex | Select-Object -First 1)
    }
    return $null
}

# Human-readable list of usable uplinks, with the SSID each one is on.
function Format-Candidates {
    $lines = @()
    foreach ($n in (Get-UplinkCandidates)) {
        $prof = (Get-NetConnectionProfile -InterfaceIndex $n.ifIndex -ErrorAction SilentlyContinue).Name
        $ssid = if ($prof) { "  ssid/profile='$prof'" } else { '' }
        $lines += "    - $($n.InterfaceAlias)   [$($n.InterfaceDescription)]$ssid"
    }
    if (-not $lines.Count) { $lines += '    (none found)' }
    return ($lines -join "`n")
}

function Get-NicGateway($alias) {
    $r = Get-NetRoute -InterfaceAlias $alias -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($r) { return $r.NextHop }
    return $null
}

function Get-NicMetric($alias) {
    (Get-NetIPInterface -InterfaceAlias $alias -AddressFamily IPv4).InterfaceMetric
}

# 默认路由自己的 RouteMetric。Windows 选默认网关时比的是
# **InterfaceMetric + 该路由的 RouteMetric**，不是只看 InterfaceMetric。
# 实测踩过：USB 网卡的 InterfaceMetric=50 > IT 的 35，看着"已经够高"，
# 但它的默认路由 RouteMetric=0、IT 的是 35 → 实际 50 < 70，默认出口还是被抢走、内网断。
function Get-RouteMetric($alias) {
    $r = Get-NetRoute -InterfaceAlias $alias -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue
    if (-not $r) { return 0 }
    ($r | Measure-Object -Property RouteMetric -Minimum).Minimum
}

function Get-EffectiveMetric($alias) {
    (Get-NicMetric $alias) + (Get-RouteMetric $alias)
}

function Get-TargetPrefixes {
    try {
        $ips = [System.Net.Dns]::GetHostAddresses($Target) |
               Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
               ForEach-Object { $_.IPAddressToString } | Sort-Object -Unique
    } catch { return @() }
    if ($PrefixLen -eq 32) { return @($ips | ForEach-Object { "$_/32" }) }
    $out = @()
    foreach ($ip in $ips) {
        $b = [System.Net.IPAddress]::Parse($ip).GetAddressBytes()
        if ($PrefixLen -eq 24) { $out += "$($b[0]).$($b[1]).$($b[2]).0/24" }
        elseif ($PrefixLen -eq 16) { $out += "$($b[0]).$($b[1]).0.0/16" }
        else { throw 'PrefixLen must be 16, 24 or 32' }
    }
    return @($out | Sort-Object -Unique)
}

function Show-All {
    Write-Host ''
    Write-Host '=== NICs (Up, IPv4) ===' -ForegroundColor Cyan
    Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
        $ips = (Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress }) -join ','
        [PSCustomObject]@{
            Alias      = $_.InterfaceAlias
            Description= $_.InterfaceDescription
            ifIndex    = $_.ifIndex
            IP         = $ips
            SSID       = (Get-NetConnectionProfile -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue).Name
            Gateway    = (Get-NicGateway $_.InterfaceAlias)
            Metric     = (Get-NicMetric $_.InterfaceAlias)
            RouteMetric= (Get-RouteMetric $_.InterfaceAlias)
            Effective  = (Get-EffectiveMetric $_.InterfaceAlias)
        }
    } | Format-Table -AutoSize | Out-String -Width 220 | Write-Host

    Write-Host 'Auto-detected roles (no need to type localized interface names):' -ForegroundColor Cyan
    $autoOut = Resolve-AdapterAlias $Outbound
    if ($autoOut) {
        Write-Host "  OUTBOUND (tethering, carries $Target) : $($autoOut.InterfaceAlias)   [$($autoOut.InterfaceDescription)]" -ForegroundColor Green
        $autoIn = Resolve-IntranetAlias $autoOut.InterfaceAlias
        if ($autoIn) {
            Write-Host "  INTRANET (stays default gateway)      : $($autoIn.InterfaceAlias)   [$($autoIn.InterfaceDescription)]" -ForegroundColor Green
        } else {
            Write-Host '  INTRANET : could not auto-detect -- pass -Intranet explicitly' -ForegroundColor Yellow
        }
    } else {
        Write-Host '  OUTBOUND : not found -- plug in the phone and enable USB tethering' -ForegroundColor Red
    }

    Write-Host ''
    Write-Host "Resolved IPs for $Target :" -ForegroundColor Cyan
    $p = Get-TargetPrefixes
    if ($p.Count -eq 0) { Write-Host '  (DNS failed)' -ForegroundColor Red } else { $p | ForEach-Object { Write-Host "  $_" } }

    Write-Host ''
    Write-Host 'Apply (recommended, admin):' -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\dual-net.ps1 -Apply'
    Write-Host 'Undo:' -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\dual-net.ps1 -Undo'
    Write-Host ''
}

function Apply-Config {
    $nicOut = Resolve-AdapterAlias $Outbound
    if (-not $nicOut) {
        throw ('Outbound uplink not found or not Up.' + "`n" +
               '  For phone USB tethering: plug the phone and enable USB tethering.' + "`n" +
               '  For a USB Wi-Fi dongle:  pass its SSID, e.g. -Outbound huatie5g' + "`n" +
               '  Usable uplinks right now:' + "`n" + (Format-Candidates) + "`n" +
               '  (run with no parameters for full details)')
    }
    $nicIn = Resolve-AdapterAlias $Intranet $nicOut.InterfaceAlias
    if (-not $nicIn) { $nicIn = Resolve-IntranetAlias $nicOut.InterfaceAlias }
    if (-not $nicIn) {
        $same = Resolve-AdapterAlias $Intranet
        if ($same -and $same.ifIndex -eq $nicOut.ifIndex) {
            throw ("-Intranet and -Outbound both resolved to '$($same.InterfaceAlias)'. They must be two different uplinks.")
        }
        throw ('Intranet uplink not found or not Up.' + "`n" +
               '  -> Is the corporate Wi-Fi still connected? (plugging in a device can coincide with a Wi-Fi drop)' + "`n" +
               '  -> Pass its SSID explicitly, e.g. -Intranet IT' + "`n" +
               '  Usable uplinks right now:' + "`n" + (Format-Candidates))
    }
    if ($nicIn.ifIndex -eq $nicOut.ifIndex) { throw 'Intranet and Outbound must be different adapters.' }

    $gwIn = Get-NicGateway $nicIn.InterfaceAlias
    $gwOut = Get-NicGateway $nicOut.InterfaceAlias
    if (-not $gwIn) { throw "No default gateway on '$($nicIn.InterfaceAlias)'." }
    if (-not $gwOut) { throw "No default gateway on '$($nicOut.InterfaceAlias)'." }

    $metricBefore = @{}
    $metricBefore[$nicIn.InterfaceAlias] = Get-NicMetric $nicIn.InterfaceAlias
    $metricBefore[$nicOut.InterfaceAlias] = Get-NicMetric $nicOut.InterfaceAlias
    # 有效开销（InterfaceMetric + 默认路由的 RouteMetric）才是 Windows 真正比的东西
    $effIn = Get-EffectiveMetric $nicIn.InterfaceAlias
    $effOut = Get-EffectiveMetric $nicOut.InterfaceAlias
    $routeOut = Get-RouteMetric $nicOut.InterfaceAlias

    $added = @()

    Write-Host ''
    Write-Host "Mode: $Mode$(if ($DryRun) { '  (DRY RUN - nothing will be changed)' })" -ForegroundColor Cyan
    Write-Host "  intranet NIC : $($nicIn.InterfaceAlias)  ip=$($nicIn.ifIndex)  gw=$gwIn  metric=$($metricBefore[$nicIn.InterfaceAlias])  effective=$effIn"
    Write-Host "  outbound NIC : $($nicOut.InterfaceAlias)  ip=$($nicOut.ifIndex)  gw=$gwOut  metric=$($metricBefore[$nicOut.InterfaceAlias])  effective=$effOut  (routeMetric=$routeOut)"
    Write-Host ''

    if ($Mode -eq 'OpencodeOnly') {
        # 1) 让内网网卡继续当默认网关。
        # 比的是**有效开销**：Windows 用 InterfaceMetric + 默认路由的 RouteMetric 决定谁当默认网关。
        # 要保证 effOut > effIn，而我们能改的只有 InterfaceMetric，所以：
        #    新 InterfaceMetric = effIn - 该网卡自己的 routeMetric + 10
        if ($effOut -le $effIn) {
            $newM = $effIn - $routeOut + 10
            if ($newM -lt 1) { $newM = 1 }
            if (-not $DryRun) {
                Set-NetIPInterface -InterfaceAlias $nicOut.InterfaceAlias -AddressFamily IPv4 -InterfaceMetric $newM
            }
            Write-Host "  metric: $($nicOut.InterfaceAlias) interfaceMetric $($metricBefore[$nicOut.InterfaceAlias]) -> $newM  (effective $effOut -> $($newM + $routeOut) > intranet $effIn，内网继续当默认)" -ForegroundColor Green
        } else {
            Write-Host "  metric: already fine (outbound effective $effOut > intranet $effIn)" -ForegroundColor DarkGray
        }

        # 2) send only the target out through the second NIC
        foreach ($p in (Get-TargetPrefixes)) {
            if ($DryRun) { $added += $p; Write-Host "  + $p  -> $($nicOut.InterfaceAlias)   (dry run)" -ForegroundColor Green; continue }
            Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $p -InterfaceIndex $nicOut.ifIndex -ErrorAction SilentlyContinue |
                Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
            New-NetRoute -DestinationPrefix $p -InterfaceIndex $nicOut.ifIndex -NextHop $gwOut -RouteMetric 1 -ErrorAction Stop | Out-Null
            $added += $p
            Write-Host "  + $p  -> $($nicOut.InterfaceAlias)" -ForegroundColor Green
        }
    }
    else {
        # PreferOutbound: the second uplink becomes default, intranet pinned back
        if (-not $DryRun) {
            Set-NetIPInterface -InterfaceAlias $nicOut.InterfaceAlias -AddressFamily IPv4 -InterfaceMetric 10
        }
        Write-Host "  metric: $($nicOut.InterfaceAlias) -> 10  (becomes default gateway)" -ForegroundColor Green

        if ($DryRun) {
            $added += $CorpPrefix
            Write-Host "  + $CorpPrefix  -> $($nicIn.InterfaceAlias)  (intranet pinned back)   (dry run)" -ForegroundColor Green
        } else {
            Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $CorpPrefix -InterfaceIndex $nicIn.ifIndex -ErrorAction SilentlyContinue |
                Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
            New-NetRoute -DestinationPrefix $CorpPrefix -InterfaceIndex $nicIn.ifIndex -NextHop $gwIn -RouteMetric 1 -ErrorAction Stop | Out-Null
            $added += $CorpPrefix
            Write-Host "  + $CorpPrefix  -> $($nicIn.InterfaceAlias)  (intranet pinned back)" -ForegroundColor Green
        }
    }

    if ($DryRun) {
        Write-Host ''
        Write-Host 'Dry run finished - nothing changed. Re-run with -Apply to commit.' -ForegroundColor Yellow
        Write-Host ''
        return
    }

    @{
        Mode = $Mode
        Prefixes = $added
        MetricBefore = $metricBefore
        OutboundAlias = $nicOut.InterfaceAlias
        IntranetAlias = $nicIn.InterfaceAlias
        CreatedAt = (Get-Date).ToString('s')
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $StateFile -Encoding UTF8

    # ---- verification ----
    Write-Host ''
    Write-Host '=== Verification ===' -ForegroundColor Cyan

    $gwOk = Test-NetConnection -ComputerName $gwIn -InformationLevel Quiet -WarningAction SilentlyContinue
    Write-Host ("  intranet gateway $gwIn : " + $(if ($gwOk) { 'REACHABLE' } else { 'NOT reachable' })) -ForegroundColor $(if ($gwOk) { 'Green' } else { 'Red' })

    foreach ($p in (Get-TargetPrefixes)) {
        $ip = $p -replace '/(24|32)$', ''
        $route = Find-NetRoute -RemoteIPAddress $ip -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($route) {
            $via = (Get-NetAdapter -InterfaceIndex $route.InterfaceIndex).InterfaceAlias
            $color = if ($via -eq $nicOut.InterfaceAlias) { 'Green' } else { 'Red' }
            Write-Host "  $ip  goes via  $via" -ForegroundColor $color
        }
    }

    Write-Host ''
    Write-Host "State: $StateFile" -ForegroundColor DarkGray
    Write-Host 'Undo:  powershell -ExecutionPolicy Bypass -File scripts\dual-net.ps1 -Undo' -ForegroundColor Yellow
    Write-Host ''
}

function Undo-Config {
    if (-not (Test-Path $StateFile)) { Write-Host 'Nothing to undo (no state file).' -ForegroundColor Yellow; return }
    $s = Get-Content $StateFile -Raw | ConvertFrom-Json

    foreach ($p in $s.Prefixes) {
        Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $p -ErrorAction SilentlyContinue |
            Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "  removed route $p"
    }
    foreach ($alias in $s.MetricBefore.PSObject.Properties.Name) {
        $m = $s.MetricBefore.$alias
        try {
            Set-NetIPInterface -InterfaceAlias $alias -AddressFamily IPv4 -InterfaceMetric $m -ErrorAction Stop
            Write-Host "  restored metric $alias = $m"
        } catch { Write-Host "  could not restore $alias ($($_.Exception.Message))" -ForegroundColor DarkGray }
    }
    Remove-Item $StateFile -Force
    Write-Host 'Undo complete.' -ForegroundColor Green
}

if ($Apply -or $Undo) {
    # -DryRun 什么都不改，不该要管理员 —— 先让你无权限也能把计划看清楚。
    # （原先 -Apply -DryRun 也会被这条挡下来，白跑一趟。）
    if (-not ($DryRun -and -not $Undo) -and -not (Test-Admin)) {
        Write-Host 'Run as Administrator (this changes routing/metrics).' -ForegroundColor Red
        Write-Host '(Show mode needs no admin. -DryRun also needs no admin.)' -ForegroundColor DarkGray
        exit 1
    }
}

if ($Undo) { Undo-Config }
elseif ($Apply) { Apply-Config }
else { Show-All }
