Set shell = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\scripts\windows-bootstrap.ps1"" -Mode Build"
shell.Run cmd, 1, False
