// 一键停止 QQ 机器人：先优雅停桥接（/api/restart 只保存状态并退出），再关 SnowLuma。
//
// 用法：
//   node scripts/shutdown.mjs              # 桥接 + SnowLuma 都关
//   node scripts/shutdown.mjs --bridge-only    # 只关桥接，SnowLuma（QQ 在线态）留着
//   node scripts/shutdown.mjs --snowluma-only  # 只关 SnowLuma
//
// 按端口找 PID（tasklist 在本机沙箱里被拒，netstat 不受限），taskkill /T /F 兜底。
// 日志：logs/shutdown.log
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const LOG = path.join(ROOT, "logs", "shutdown.log");
const BRIDGE_PORT = 3100;
const SNOWLUMA_PORTS = [3000, 3001, 5099];
const BRIDGE_ONLY = process.argv.includes("--bridge-only");
const SNOWLUMA_ONLY = process.argv.includes("--snowluma-only");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${line}\n`, "utf8");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listenerPids(ports) {
  const wanted = new Set(ports);
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, maxBuffer: 8 << 20 });
    const found = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!m) continue;
      const port = Number(m[2]);
      if (!wanted.has(port)) continue;
      found.set(port, Number(m[3]));
    }
    return found;
  } catch (error) {
    log(`netstat 失败：${error?.message ?? error}`);
    return new Map();
  }
}

async function killPid(pid, label) {
  if (!pid) return false;
  try {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    log(`${label} 已结束（pid ${pid}）`);
    return true;
  } catch (error) {
    const msg = String(error?.stderr || error?.message || error).trim();
    log(`${label} 结束失败（pid ${pid}）：${msg.split(/\r?\n/)[0]}`);
    return false;
  }
}

async function stopBridge() {
  const pids = await listenerPids([BRIDGE_PORT]);
  if (!pids.size) {
    log("qq-bridge 未在运行（3100 无监听），跳过");
    return true;
  }
  const pid = pids.get(BRIDGE_PORT);
  let graceful = false;
  try {
    const token = fs.readFileSync(path.join(ROOT, "state", "console-token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/restart`, {
      method: "POST",
      headers: { "x-console-token": token, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000)
    });
    graceful = res.ok;
    log(`已请求桥接保存状态并退出（HTTP ${res.status}）`);
  } catch (error) {
    log(`优雅停止未成功（${error?.message ?? error}），改用 taskkill`);
  }
  if (graceful) {
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      if (!(await listenerPids([BRIDGE_PORT])).size) {
        log("qq-bridge 已退出（3100 已释放）");
        return true;
      }
    }
    log("桥接 6 秒内未退出，改用 taskkill");
  }
  const ok = await killPid(pid, "qq-bridge");
  await sleep(800);
  return ok;
}

async function stopSnowLuma() {
  const pids = await listenerPids(SNOWLUMA_PORTS);
  if (!pids.size) {
    log("SnowLuma 未在运行（3000/3001/5099 无监听），跳过");
    return true;
  }
  const unique = [...new Set(pids.values())];
  let ok = true;
  for (const pid of unique) ok = (await killPid(pid, "SnowLuma")) && ok;
  await sleep(1200);
  const left = await listenerPids(SNOWLUMA_PORTS);
  if (left.size) {
    log(`⚠️ 仍有端口在监听：${[...left.keys()].join("/")}（可能权限不足，需管理员终端）`);
    return false;
  }
  log("SnowLuma 已关闭");
  return ok;
}

const bridgeOk = SNOWLUMA_ONLY ? true : await stopBridge();
const snowOk = BRIDGE_ONLY ? true : await stopSnowLuma();
const bridgeText = SNOWLUMA_ONLY ? "未动" : bridgeOk ? "已停" : "失败";
const snowText = BRIDGE_ONLY ? "未动" : snowOk ? "已停" : "失败";
log(`结果：桥接=${bridgeText} SnowLuma=${snowText}`);
process.exitCode = bridgeOk && snowOk ? 0 : 1;
