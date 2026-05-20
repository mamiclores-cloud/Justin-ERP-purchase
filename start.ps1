# Smart Purchase Console - Hidden Launcher
# After clicking the start shortcut, node runs detached in background.
# Browser opens automatically. This script exits immediately.
# Staff cannot accidentally kill the server (no console window visible).
# Server stdout -> state\server.log, stderr -> state\server.err.log
# To stop the server, run stop.bat.
#
# This file uses ASCII-only comments and messages so that PowerShell 5.1
# can parse it regardless of file BOM / system code page.

$ErrorActionPreference = 'SilentlyContinue'
Set-Location -Path $PSScriptRoot

function Show-ErrorDialog($message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, 'Purchase Console - Startup Failed', 'OK', 'Error') | Out-Null
}

# --- Node.js check ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Show-ErrorDialog "Node.js not found in PATH.`r`nPlease install Node.js and try again."
    exit 1
}

# --- server.js check ---
if (-not (Test-Path "$PSScriptRoot\server.js")) {
    Show-ErrorDialog "server.js not found at:`r`n$PSScriptRoot\server.js"
    exit 1
}

# --- Detect Chrome (any of these standard install paths) ---
$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

# --- Check if port 3001 is already in use (server already running) ---
function Test-PortListening([int]$port) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect('127.0.0.1', $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(200, $false)
        if ($ok) { try { $tcp.EndConnect($iar) } catch {}; $tcp.Close(); return $true }
        $tcp.Close()
        return $false
    } catch { return $false }
}

$alreadyRunning = Test-PortListening 3001

if (-not $alreadyRunning) {
    # Ensure state\ exists for log files
    $stateDir = Join-Path $PSScriptRoot 'state'
    if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }
    $logOut = Join-Path $stateDir 'server.log'
    $logErr = Join-Path $stateDir 'server.err.log'

    # Launch node detached + hidden. Wrap with cmd /c so the shell handles
    # stdout/stderr redirect itself -- PowerShell's -RedirectStandardOutput is
    # unreliable when the host PowerShell is launched with -WindowStyle Hidden.
    $cmdLine = "/c node.exe server.js > `"$logOut`" 2> `"$logErr`""
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList $cmdLine `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden | Out-Null

    # Poll port until server listens (max 10s, every 200ms)
    $up = $false
    for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 200
        if (Test-PortListening 3001) { $up = $true; break }
    }
    if (-not $up) {
        Show-ErrorDialog "Server did not respond on port 3001 within 10s.`r`nCheck state\server.log and state\server.err.log for details."
        exit 1
    }
}

# --- Open browser ---
if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList '--new-window', 'http://localhost:3001'
} else {
    Start-Process 'http://localhost:3001'
}

# Exit -- node keeps running in background
exit 0
