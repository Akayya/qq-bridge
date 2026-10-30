' 可选的开机自启入口（默认**不安装**：2026-10-30 起启动文件夹里已不再放这个文件，
' 只保留手动双击桌面「启动QQ机器人.cmd」）。
'
' 想恢复开机自启，把本文件复制到「启动」文件夹：
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
' 默认带 --no-snowluma 只启桥接；想让 SnowLuma 也跟着自启就删掉这个参数。
' 位置解析顺序：环境变量 QQ_BRIDGE_HOME → 本脚本所在目录。
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = sh.ExpandEnvironmentStrings("%QQ_BRIDGE_HOME%")
If base = "%QQ_BRIDGE_HOME%" Then base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & base & "\autostart.cmd"" --no-snowluma", 0, False