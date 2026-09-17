Option Explicit
Dim shell, files, scriptPath, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "ensure-cutflow.ps1")
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & scriptPath & """"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "-OpenBrowser" Then command = command & " -OpenBrowser"
End If
' GUI host creates PowerShell hidden from the outset; wait to preserve task status.
result = shell.Run(command, 0, True)
WScript.Quit result
