// 启动桥接（完全脱离当前进程树，关掉这个终端也不会停）。
// DSH 桌面版每次启动会换端口，所以先把 config.json 的 dsh.baseUrl 校正到当前实例，
// 再拉起 src/bridge.js —— 否则桥接会连着上一个已经关掉的端口，表现为「bot 不回话」。
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncDshPort } from "./scripts/sync-dsh-port.mjs";

try {
  await syncDshPort({ quiet: false });
} catch (error) {
  console.warn("[launch] 端口校正失败（继续按 config.json 里的地址启动）：", error?.message ?? error);
}

const out = fs.openSync("logs/bridge.out.log", "a");
const err = fs.openSync("logs/bridge.err.log", "a");
const child = spawn(process.execPath, ["src/bridge.js"], { detached: true, stdio: ["ignore", out, err], cwd: process.cwd(), windowsHide: true });
child.unref();
console.log("spawned pid " + child.pid);
