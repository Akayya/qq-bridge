' Autostart entry for qq-bridge (placed in the user Startup folder).
' Runs qq-bridge\autostart.cmd hidden: launch SnowLuma, wait for DSH, then start the bridge.
Set sh = CreateObject("WScript.Shell")
sh.Run """D:\DSH_QQ_BOT\autostart.cmd""", 0, False
