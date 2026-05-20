@echo off
REM Smart Purchase Console - bat wrapper that delegates to start.vbs
REM ASCII-only to avoid cmd code page misparsing of multi-byte chars.
REM Zero-flash launch: point your shortcut directly at start.vbs instead.
start "" wscript.exe "%~dp0start.vbs"
