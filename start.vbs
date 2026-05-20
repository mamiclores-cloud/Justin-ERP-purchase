' Smart Purchase Console - Zero-flash Launcher
' Launched via wscript.exe (no window), uses SW_HIDE to spawn
' powershell -WindowStyle Hidden start.ps1.
' Staff sees no cmd / powershell window, just Chrome opening.
'
' Desktop shortcut should point directly to this .vbs for cleanest UX.
' start.bat is kept as a backward-compat wrapper (flashes briefly).

Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")

projDir = fs.GetParentFolderName(WScript.ScriptFullName)
psPath  = projDir & "\start.ps1"

cmd = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -NoProfile -File """ & psPath & """"

' 0 = SW_HIDE, False = do not wait for child
sh.Run cmd, 0, False
