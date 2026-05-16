# 智能採購控制台 — One-click Launcher
# Starts server and opens Chrome browser
# Close this window to stop the server

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Set-Location -Path $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "Purchase Console (3001)"

Clear-Host
Write-Host ""
Write-Host "  ===============================================" -ForegroundColor Green
Write-Host "    智能採購控制台 - Launcher" -ForegroundColor Green
Write-Host "  ===============================================" -ForegroundColor Green
Write-Host ""
Write-Host "   URL : http://localhost:3001"
Write-Host "   Dir : $PSScriptRoot"
Write-Host ""

# Node.js check
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  [ERROR] Node.js not found in PATH" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# server.js check
if (-not (Test-Path "server.js")) {
    Write-Host "  [ERROR] server.js not found" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Detect Chrome
$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) {
    Write-Host "   Chrome: $chrome" -ForegroundColor DarkGray
} else {
    Write-Host "   Chrome: not detected, using default browser" -ForegroundColor Yellow
}
Write-Host ""

# Port 3001 check
$portInUse = $false
try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 3001)
    $listener.Start()
    $listener.Stop()
} catch { $portInUse = $true }

if ($portInUse) {
    Write-Host "  [INFO] Port 3001 already in use, opening browser only." -ForegroundColor Yellow
    if ($chrome) {
        Start-Process -FilePath $chrome -ArgumentList '--new-window', 'http://localhost:3001'
    } else {
        Start-Process 'http://localhost:3001'
    }
    Read-Host "Press Enter to close"
    exit 0
}

Write-Host "   * Close this window to stop the server" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  -----------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

# Background: open Chrome after 3s
$openBrowserScript = if ($chrome) {
    "Start-Sleep 3; Start-Process -FilePath '$chrome' -ArgumentList '--new-window','http://localhost:3001'"
} else {
    "Start-Sleep 3; Start-Process 'http://localhost:3001'"
}
Start-Process -WindowStyle Hidden powershell -ArgumentList '-NoProfile', '-Command', $openBrowserScript

try {
    & node server.js
} finally {
    Write-Host ""
    Write-Host "  -----------------------------------------------" -ForegroundColor DarkGray
    Write-Host "  Server stopped" -ForegroundColor Yellow
    Read-Host "Press Enter to close"
}
