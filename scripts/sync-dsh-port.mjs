// DSH 桌面版每次启动会换一个随机回环端口（60019 → 62280 这种），
// 而 qq-bridge 的 config.json 里 dsh.baseUrl 是写死的，于是 DSH 一重启桥接就连不上、
// 表现为「bot 不回话」。这个脚本负责把 baseUrl 校正到当前真正在跑的那个 DSH。
//
// 识别方法：逐个探测本机回环监听端口，DSH 未鉴权时根路径会回
// `dsh web authentication required; reopen the URL printed by dsh web.`
// （或已放行时页面里带 __DSH_BOOT__），两者任一命中即认定是 DSH。
//
// 用法：
//   node scripts/sync-dsh-port.mjs          # 校正 config.json 并打印结果
//   node scripts/sync-dsh-port.mjs --check  # 只打印，不写文件（退出码 0=一致，1=不一致）
// 被 launch-detached.mjs 在启动桥接前自动调用。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG = path.join(ROOT, "config.json");
const MARKERS = ["dsh web authentication required", "__DSH_BOOT__"];

async function listeningPorts() {
  const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, maxBuffer: 8 << 20 });
  const ports = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const host = m[1];
    if (!["127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(host)) continue;
    const port = Number(m[2]);
    if (port > 0 && port < 65536) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700), redirect: "manual" });
    const text = (await res.text()).slice(0, 4000);
    if (MARKERS.some((m) => text.includes(m))) return { port, status: res.status };
  } catch {}
  return null;
}

async function findDshPorts() {
  const ports = await listeningPorts();
  const hits = [];
  const BATCH = 12;
  for (let i = 0; i < ports.length; i += BATCH) {
    const slice = ports.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(probe));
    for (const r of results) if (r) hits.push(r);
  }
  return hits;
}

export async function syncDshPort({ check = false, quiet = false } = {}) {
  const hits = await findDshPorts();
  if (!hits.length) {
    if (!quiet) console.error("[sync-dsh-port] 没找到在跑的 DSH（是否有 dsh web / 桌面版在运行？）");
    return { ok: false, reason: "no-dsh" };
  }
  const target = `http://127.0.0.1:${hits[0].port}`;
  const raw = fs.readFileSync(CONFIG, "utf8");
  const cfg = JSON.parse(raw);
  const before = String(cfg?.dsh?.baseUrl ?? "");
  if (before === target) {
    if (!quiet) console.log(`[sync-dsh-port] baseUrl 已是最新：${target}${hits.length > 1 ? `（另有 ${hits.length - 1} 个 DSH 实例在跑）` : ""}`);
    return { ok: true, changed: false, baseUrl: target, candidates: hits.map((h) => h.port) };
  }
  if (check) {
    console.log(`[sync-dsh-port] 不一致：config=${before || "(空)"} 实际=${target}`);
    return { ok: true, changed: false, baseUrl: target, candidates: hits.map((h) => h.port), mismatch: true };
  }
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: target };
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  if (!quiet) console.log(`[sync-dsh-port] baseUrl：${before || "(空)"} → ${target}`);
  return { ok: true, changed: true, before, baseUrl: target, candidates: hits.map((h) => h.port) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const check = process.argv.includes("--check");
  const result = await syncDshPort({ check });
  if (!result.ok) process.exitCode = 2;
  else if (result.mismatch) process.exitCode = 1;
}
