// 开机自启（Windows 登录时由启动文件夹里的 autostart.vbs 调起）。
//
// 顺序：SnowLuma（launcher.bat）→ 等 OneBot 3000 端口 → 等 DSH 起来并校正 baseUrl →
// 拉起 qq-bridge。任何一步已经在线就跳过，所以手动点一次也不会起重复实例。
// 开机那条链（启动文件夹里的 vbs）带 --no-snowluma，只启桥接；手动双击
// 桌面「启动QQ机器人.cmd」仍会顺带把 SnowLuma 拉起来。
//
// 用法：
//   node scripts/autostart.mjs            # 正常自启流程
//   node scripts/autostart.mjs --dry-run  # 只检查当前状态，不启动任何东西
//
// 日志：logs/autostart.log
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { syncDshPort } from "./sync-dsh-port.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOG = path.join(ROOT, "logs", "autostart.log");
const SNOWLUMA_DIR = process.env.SNOWLUMA_DIR || "D:/SnowLuma";
const LAUNCHER = path.join(SNOWLUMA_DIR, "launcher.bat");
const DRY = process.argv.includes("--dry-run");

// 开机时是否顺手把 SnowLuma 也拉起来。
// 优先级：`--no-snowluma` 参数（开机自启那条链用）> config.json 的
// `autostart.launchSnowLuma` > 默认 true。
// 关掉后不再等 3000 端口（桥接会自己重连，SnowLuma 起来后自然连上）。
function launchSnowLumaEnabled() {
  if (process.argv.includes("--no-snowluma")) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8").replace(/^\uFEFF/, ""));
    return cfg?.autostart?.launchSnowLuma !== false;
  } catch {
    return true;
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${line}\n`, "utf8");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function waitPort(port, budgetMs, label) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) {
      log(`${label} 已就绪（127.0.0.1:${port}）`);
      return true;
    }
    await sleep(2000);
  }
  log(`⚠️ 等待 ${label} 超时（${Math.round(budgetMs / 1000)}s），继续下一步`);
  return false;
}

function startSnowLuma() {
  if (!fs.existsSync(LAUNCHER)) {
    log(`⚠️ 找不到 ${LAUNCHER}，跳过 SnowLuma 启动`);
    return false;
  }
  const winLauncher = LAUNCHER.replace(/\//g, "\\");
  const child = spawn("cmd.exe", ["/c", "start", "", winLauncher], {
    cwd: SNOWLUMA_DIR.replace(/\//g, "\\"),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  log(`已启动 SnowLuma：${winLauncher}`);
  return true;
}

async function waitDsh(budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const result = await syncDshPort({ quiet: true });
    if (result.ok) {
      log(`DSH 已就绪：${result.baseUrl}${result.changed ? "（已校正 config.json）" : ""}`);
      return result;
    }
    await sleep(3000);
  }
  log("⚠️ 等待 DSH 超时，桥接会按 config.json 里的旧地址启动并自行重连");
  return { ok: false };
}

function startBridge() {
  const out = fs.openSync(path.join(ROOT, "logs", "bridge.out.log"), "a");
  const err = fs.openSync(path.join(ROOT, "logs", "bridge.err.log"), "a");
  const child = spawn(process.execPath, ["src/bridge.js"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true
  });
  child.unref();
  log(`已启动 qq-bridge（pid ${child.pid}）`);
}

const snowlumaUp = await portOpen(3000);
const bridgeUp = await portOpen(3100);
log(`启动检查：SnowLuma=${snowlumaUp ? "在线" : "未运行"} bridge=${bridgeUp ? "在线" : "未运行"}${DRY ? "（dry-run）" : ""}`);

if (DRY) {
  const dsh = await syncDshPort({ check: true, quiet: false });
  log(`DSH 探测：${dsh.ok ? dsh.baseUrl : "未找到"}`);
  process.exit(0);
}

if (!snowlumaUp && launchSnowLumaEnabled()) {
  startSnowLuma();
  await waitPort(3000, 180000, "SnowLuma OneBot");
} else if (!snowlumaUp) {
  log("SnowLuma 未运行，但开机自启已关闭（--no-snowluma 或 config.autostart.launchSnowLuma=false），跳过启动与等待；桥接会自己重连");
} else {
  log("SnowLuma 已在运行，跳过启动");
}

await waitDsh(300000);

if (!(await portOpen(3100))) {
  startBridge();
} else {
  log("qq-bridge 已在运行，跳过启动");
}
log("自启流程结束");
