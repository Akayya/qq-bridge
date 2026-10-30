' Autostart entry for qq-bridge (template).
' 放进「启动」文件夹后，它会在登录时隐藏运行 qq-bridge\autostart.cmd --no-snowluma：
' 只拉起 qq-bridge（DSH 就绪后自动校正 baseUrl），SnowLuma 由你自己启动。
' 想让开机时也顺带拉起 SnowLuma：把下面的 --no-snowluma 删掉即可。
' 位置解析顺序：环境变量 QQ_BRIDGE_HOME → 本脚本所在目录。
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = sh.ExpandEnvironmentStrings("%QQ_BRIDGE_HOME%")
If base = "%QQ_BRIDGE_HOME%" Then base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & base & "\autostart.cmd"" --no-snowluma", 0, False