' Runs backup-memory.cmd with NO console window.
'
' Task Scheduler runs the action in the interactive session, so pointing it
' straight at a .cmd flashes a black window for the whole backup (~5 s) every
' 6 hours. wscript has no console, and Run(..., 0, ...) hides the cmd it
' spawns, so the child node/git processes inherit the hidden console too.
Dim fso, sh, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run """" & root & "\scripts\backup-memory.cmd""", 0, True