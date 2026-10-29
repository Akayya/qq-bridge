' Autostart entry for qq-bridge (template).
' 放进「启动」文件夹后，它会在登录时隐藏运行 qq-bridge\autostart.cmd：
' 先拉起 SnowLuma，等 DSH 就绪，再启动桥接。
' 位置解析顺序：环境变量 QQ_BRIDGE_HOME → 本脚本所在目录。
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = sh.ExpandEnvironmentStrings("%QQ_BRIDGE_HOME%")
If base = "%QQ_BRIDGE_HOME%" Then base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & base & "\autostart.cmd""", 0, False
