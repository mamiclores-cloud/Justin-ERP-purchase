# 智能採購控制台 - Stop Script
# Kills the server process listening on port 3001

$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Host.UI.RawUI.WindowTitle = "Stop Purchase Server"

Clear-Host
Write-Host ""
Write-Host "  ===============================================" -ForegroundColor Green
Write-Host "    Stop 智能採購控制台" -ForegroundColor Green
Write-Host "  ===============================================" -ForegroundColor Green
Write-Host ""

$conns = netstat -ano 2>$null | Select-String ":3001.*LISTENING"
$pids = @()
foreach ($c in $conns) {
    $tokens = $c.ToString().Trim() -split '\s+'
    $p = $tokens[-1]
    if ($p -match '^\d+$') { $pids += [int]$p }
}
$pids = $pids | Sort-Object -Unique

if ($pids.Count -eq 0) {
    Write-Host "  [INFO] No server running on port 3001" -ForegroundColor Yellow
} else {
    foreach ($p in $pids) {
        $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.ProcessName } else { '?' }
        Write-Host "  Killing PID $p ($name)..." -ForegroundColor Yellow
        try {
            Stop-Process -Id $p -Force -ErrorAction Stop
            Write-Host "    [OK] Stopped" -ForegroundColor Green
        } catch {
            Write-Host "    [FAIL] $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    Write-Host ""
    Write-Host "  Server stopped." -ForegroundColor Green
}
Write-Host ""
Start-Sleep -Seconds 2
