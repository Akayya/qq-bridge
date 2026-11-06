// 把所有会话重建一遍（用于「预设/工具面变了」之后）。
//
// 为什么需要它：DSH 只在 session/create 时确立两样东西——工具表和系统提示（角色预设）。
// 之后无论是 MCP 新增工具，还是改了 agent-presets 里的 prefix，**已有会话都不会热更新**。
// 所以改完预设或加完工具，正确顺序是：
//   1) 重启 DSH（让它加载新的 patch / 新的 MCP 工具表）
//   2) 双击桌面「启动QQ机器人.cmd」（同步 DSH 端口并重启桥接）
//   3) node scripts/reset-sessions.mjs
// 之后下一次有人说话，桥接会用新的会话创建，工具与系统提示都是最新的。
//
// 用法：
//   node scripts/reset-sessions.mjs               # 重建所有会话
//   node scripts/reset-sessions.mjs --dry         # 只看会重建哪些
//   node scripts/reset-sessions.mjs --key private:227277385  # 只重建一个
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const keyArg = (() => {
  const i = args.indexOf('--key');
  return i >= 0 ? args[i + 1] : null;
})();

function readConfig() {
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function readToken() {
  const p = path.join(ROOT, 'state', 'console-token');
  return fs.readFileSync(p, 'utf8').trim();
}

const cfg = readConfig();
const base = `http://127.0.0.1:${Number(cfg.port) || 3100}`;
const token = readToken();
const headers = { 'x-console-token': token, 'content-type': 'application/json' };

async function main() {
  const st = await (await fetch(`${base}/api/socialV2/state`, { headers })).json();
  const keys = Object.keys(st.sessions || {}).sort();
  const targets = keyArg ? keys.filter((k) => k === keyArg) : keys;
  if (!targets.length) {
    console.log('没有需要重建的会话');
    return;
  }
  console.log(`平台 ${st.mode || st.platform || ''}，共 ${keys.length} 个会话，本次处理 ${targets.length} 个：`);
  for (const key of targets) {
    const sid = st.sessions[key];
    if (dry) {
      console.log(`  [dry] ${key} → ${String(sid).slice(0, 18)}…`);
      continue;
    }
    const res = await fetch(`${base}/api/socialV2/reset-session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key })
    });
    const body = await res.json().catch(() => ({}));
    if (body.ok) console.log(`  ✓ ${key}（旧会话 ${String(sid).slice(0, 18)}… 已退役）`);
    else console.log(`  ✗ ${key}：${body.error || res.status}`);
  }
  console.log(dry ? '（dry run，没有真的重建）' : '完成。下一次有人说话时，新会话会带上最新的工具与系统提示。');
}

main().catch((e) => {
  console.error('失败：', e?.message || e);
  process.exit(1);
});