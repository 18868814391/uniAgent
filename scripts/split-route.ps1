# =============================================================
#  split-route.ps1
#  Send *only* opencode.ai (Cloudflare) traffic out through a second NIC,
#  while everything else (intranet, domestic sites) keeps using the IT Wi-Fi.
#
#  WHY: measured on the IT Wi-Fi, the path egress -> Cloudflare collapses to
#  63-96 KB/s, while a 5G uplink reaches 1.1-2.2 MB/s. Intranet needs the IT
#  Wi-Fi. With two NICs we can have both at the same time.
#
#  REQUIRES: a second physical NIC (USB Wi-Fi dongle, USB-Ethernet, or phone
#  USB tethering). This laptop has only ONE wireless card, so a second one is
#  mandatory for this script to be useful.
#
#  RUN AS ADMINISTRATOR.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File scripts\split-route.ps1
#        -> Show mode: lists NICs, default route, resolved opencode.ai IPs
#
#    powershell -ExecutionPolicy Bypass -File scripts\split-route.ps1 -Apply -Adapter "Ethernet 3"
#        -> Add /32 host routes for every opencode.ai A record via that NIC
#
#    powershell -ExecutionPolicy Bypass -File scripts\split-route.ps1 -Apply -Adapter "Ethernet 3" -PrefixLen 24
#        -> Route the whole /24 instead (more resilient to Cloudflare IP changes)
#
#    powershell -ExecutionPolicy Bypass -File scripts\split-route.ps1 -Undo
#        -> Remove everything this script added
#
#  Notes:
#    - Routes are added to the ACTIVE policy store only (gone after reboot).
#    - If Cloudflare rotates IPs, re-run -Apply.
#    - Nothing else is modified: no MTU, no proxy, no DNS, no default route.
# =============================================================

[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Undo,
    [string]$Adapter,
    [int]$PrefixLen = 32
)

$ErrorActionPreference = 'Stop'
$Target = 'opencode.ai'
$StateFile = Join-Path $env:TEMP 'opencode-split-route.json'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TargetIPs {
    try {
        $ips = [System.Net.Dns]::GetHostAddresses($Target) |
               Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
               ForEach-Object { $_.IPAddressToString } |
               Sort-Object -Unique
        return @($ips)
    } catch {
        return @()
    }
}

function Show-State {
    Write-Host ''
    Write-Host '=== Network adapters (IPv4, Up) ===' -ForegroundColor Cyan
    Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } |
        ForEach-Object {
            $ips = (Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                    Where-Object { $_.IPAddress -notlike '169.254.*' } |
                    ForEach-Object { $_.IPAddress }) -join ', '
            $gw = (Get-NetRoute -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
                   ForEach-Object { $_.NextHop }) -join ', '
            [PSCustomObject]@{
                Alias = $_.InterfaceAlias
                ifIndex = $_.ifIndex
                Link = $_.LinkSpeed
                IP = $ips
                Gateway = $gw
            }
        } | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

    Write-Host '=== Current default route (0.0.0.0/0) ===' -ForegroundColor Cyan
    Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
        Select-Object ifIndex, InterfaceAlias, NextHop, RouteMetric, InterfaceMetric |
        Sort-Object InterfaceMetric | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

    Write-Host "=== Resolved IPs for $Target ===" -ForegroundColor Cyan
    $ips = Get-TargetIPs
    if ($ips.Count -eq 0) {
        Write-Host "  (none - DNS failed)" -ForegroundColor Red
    } else {
        $ips | ForEach-Object { Write-Host "  $_" }
    }

    Write-Host '=== Existing host routes for those IPs ===' -ForegroundColor Cyan
    $found = $false
    foreach ($ip in $ips) {
        $rs = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$ip/32" -ErrorAction SilentlyContinue
        if ($rs) { $found = $true; $rs | Select-Object DestinationPrefix, ifIndex, InterfaceAlias, NextHop | Format-Table -AutoSize | Out-String -Width 200 | Write-Host }
    }
    if (-not $found) { Write-Host '  (none - traffic to opencode.ai goes out via the default route)' }

    Write-Host ''
    Write-Host 'Next: pick your 5G/second NIC alias above, then run with -Apply -Adapter "<alias>"' -ForegroundColor Yellow
    Write-Host ''
}

function Remove-Added {
    if (-not (Test-Path $StateFile)) {
        Write-Host 'Nothing to undo (no state file).' -ForegroundColor Yellow
        return
    }
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    foreach ($p in $state.Prefixes) {
        try {
            Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $p -ErrorAction SilentlyContinue |
                Remove-NetRoute -Confirm:$false -ErrorAction Stop
            Write-Host "  removed $p"
        } catch {
            Write-Host "  skip $p ($($_.Exception.Message))" -ForegroundColor DarkGray
        }
    }
    Remove-Item $StateFile -Force
    Write-Host 'Undo complete.' -ForegroundColor Green
}

function Apply-Routes {
    if (-not $Adapter) {
        throw 'Missing -Adapter. Run without parameters first to list adapter aliases.'
    }
    $nic = Get-NetAdapter -InterfaceAlias $Adapter -ErrorAction Stop
    if ($nic.Status -ne 'Up') {
        throw "Adapter '$Adapter' is not Up (status: $($nic.Status))."
    }
    $gw = (Get-NetRoute -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
           Select-Object -First 1 -ExpandProperty NextHop)
    if (-not $gw) {
        $gw = (Get-NetRoute -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
               Where-Object { $_.NextHop -ne '0.0.0.0' } |
               Sort-Object RouteMetric |
               Select-Object -First 1 -ExpandProperty NextHop)
    }
    if (-not $gw) { throw "Could not determine a gateway for adapter '$Adapter'." }

    $ips = Get-TargetIPs
    if ($ips.Count -eq 0) { throw "DNS resolution for $Target failed." }

    $prefixes = @()
    if ($PrefixLen -eq 32) {
        $prefixes = $ips | ForEach-Object { "$_/32" }
    } else {
        $prefixes = $ips | ForEach-Object {
            $b = [System.Net.IPAddress]::Parse($_).GetAddressBytes()
            if ($PrefixLen -eq 24) { "$($b[0]).$($b[1]).$($b[2]).0/24" }
            elseif ($PrefixLen -eq 16) { "$($b[0]).$($b[1]).0.0/16" }
            else { throw 'Only -PrefixLen 16/24/32 are supported.' }
        } | Sort-Object -Unique
    }

    Write-Host ''
    Write-Host "Routing via adapter '$Adapter' (ifIndex $($nic.ifIndex), gateway $gw):" -ForegroundColor Cyan
    foreach ($p in $prefixes) {
        try {
            Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $p -InterfaceIndex $nic.ifIndex -ErrorAction SilentlyContinue |
                Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
            New-NetRoute -DestinationPrefix $p -InterfaceIndex $nic.ifIndex -NextHop $gw -RouteMetric 1 -ErrorAction Stop | Out-Null
            Write-Host "  + $p" -ForegroundColor Green
        } catch {
            Write-Host "  ! $p  $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    @{ Prefixes = $prefixes; Adapter = $Adapter; CreatedAt = (Get-Date).ToString('s') } |
        ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
    Write-Host ''
    Write-Host "State saved to $StateFile" -ForegroundColor DarkGray
    Write-Host 'Verify with:  node scripts\net-compare.js   (compare throughput vs before)' -ForegroundColor Yellow
    Write-Host 'Undo with:    powershell -ExecutionPolicy Bypass -File scripts\split-route.ps1 -Undo' -ForegroundColor Yellow
    Write-Host ''
}

if ($Apply -or $Undo) {
    if (-not (Test-Admin)) {
        Write-Host ''
        Write-Host 'This script must run as Administrator (it changes the routing table).' -ForegroundColor Red
        Write-Host 'Right-click PowerShell -> Run as administrator, then re-run.' -ForegroundColor Red
        Write-Host '(Show mode - run with no parameters - works without admin.)' -ForegroundColor DarkGray
        Write-Host ''
        exit 1
    }
}

if ($Undo) { Remove-Added }
elseif ($Apply) { Apply-Routes }
else { Show-State }
