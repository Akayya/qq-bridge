// 本机部署相关的小工具：仓库是公开的，脚本里不该写死真实的 QQ 号。
// 优先读环境变量 BRIDGE_OWNER_QQ，其次读本机 config.json 的 ownerQQ，最后用一个占位号。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveOwnerQQ(fallback = 10001) {
  const fromEnv = Number(process.env.BRIDGE_OWNER_QQ || 0);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const n = Number(cfg?.ownerQQ || 0);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* 没有 config.json（比如刚 clone）时走 fallback */
  }
  return fallback;
}

// 测试脚本里用到的「聊天目标」也走同样的脱敏逻辑：优先环境变量，其次本机 config.json，
// 最后用不存在的占位号（那样只会命中白名单校验的 403 分支，不会真发消息）。
export function resolveChatTargets({ ownerFallback = 10001 } = {}) {
  const ownerQQ = resolveOwnerQQ(ownerFallback);
  let groupQQ = Number(process.env.BRIDGE_TEST_GROUP || 0);
  let peerQQ = Number(process.env.BRIDGE_TEST_PEER || 0);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (!groupQQ) groupQQ = Number(cfg?.allow?.groups?.[0] || 0);
    if (!peerQQ) {
      const other = (cfg?.allow?.private ?? [])
        .map((n) => Number(n))
        .find((n) => Number.isFinite(n) && n > 0 && n !== ownerQQ);
      peerQQ = other || 0;
    }
  } catch {
    /* 没有 config.json 时用占位号 */
  }
  return { ownerQQ, groupQQ: groupQQ || 100000, peerQQ: peerQQ || 10002 };
}

export { ROOT };