// 记忆快照：把跨聊天共享记忆（state/memory.db）、人物/群档案（state/profiles.json）
// 和每个会话的轻量记忆（话题/想法/印象）导出成 JSON，提交并推送到私有仓库。
//
// 用法：
//   node scripts/backup-memory.mjs                # 导出 + commit + push
//   node scripts/backup-memory.mjs --no-push      # 只导出
//   node scripts/backup-memory.mjs --dir D:\x     # 指定本地备份仓库目录
//
// 设计取舍：
//   - 只导出「记忆」，不导出 config.json / 会话令牌 / 聊天正文，避免把密钥和别人的私聊顶上云。
//   - 每天一个文件（同一天多次运行会覆盖当天文件），保留最近 60 天。
//   - 用 JSON 而不是直接提交 sqlite 文件：文本好 diff、好回收，仓库不会因为二进制膨胀。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './lib/owner.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPO_DIR = path.resolve(valueOf('--dir', process.env.BRIDGE_MEMORY_BACKUP_DIR || 'D:\\DSH_MEMORY_BACKUP'));
const KEEP_DAYS = Number(valueOf('--keep-days', '60')) || 60;
const NO_PUSH = has('--no-push');
const STATE_DIR = path.join(ROOT, 'state');
const SNAP_DIR = path.join(REPO_DIR, 'snapshots');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readMemories() {
  const dbFile = path.join(STATE_DIR, 'memory.db');
  if (!fs.existsSync(dbFile)) return [];
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare('SELECT id, kind, text, tags, scope, source_key, created_at, used_at, hits FROM memories ORDER BY id').all();
    return rows.map((r) => ({ ...r }));
  } catch (error) {
    console.error(`读取 memory.db 失败：${error?.message ?? error}`);
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function readProfiles() {
  const doc = readJson(path.join(STATE_DIR, 'profiles.json'), null);
  if (!doc) return { people: {}, groups: {} };
  return { people: doc.people ?? {}, groups: doc.groups ?? {} };
}

function readLightMemory() {
  const doc = readJson(path.join(STATE_DIR, 'social-v2.json'), null);
  const conv = doc?.conversations ?? {};
  const out = {};
  for (const [key, st] of Object.entries(conv)) {
    if (!st || typeof st !== 'object') continue;
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics : [];
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts : [];
    const impressions = Array.isArray(st.memberImpressions) ? st.memberImpressions : [];
    if (!topics.length && !thoughts.length && !impressions.length) continue;
    out[key] = {
      activeTopics: topics,
      pendingThoughts: thoughts,
      memberImpressions: impressions,
      recentCount: Array.isArray(st.recentMessages) ? st.recentMessages.length : 0,
      lastIncomingAt: st.lastIncomingAt || 0
    };
  }
  return out;
}

function pruneOldSnapshots() {
  if (!fs.existsSync(SNAP_DIR)) return 0;
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let removed = 0;
  for (const name of fs.readdirSync(SNAP_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const day = Date.parse(`${name.slice(0, 10)}T00:00:00Z`);
    if (Number.isFinite(day) && day < cutoff) {
      fs.rmSync(path.join(SNAP_DIR, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

function runGit(gitArgs) {
  const res = spawnSync('git', ['-c', 'http.sslBackend=openssl', ...gitArgs], {
    cwd: REPO_DIR,
    encoding: 'utf8',
    timeout: 120000
  });
  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
// 用本地日期命名快照，避免 UTC 时区让人误以为是「昨天」的数据
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const stamp = `${day}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

const snapshot = {
  schema: 1,
  generatedAt: now.toISOString(),
  source: { stateDir: STATE_DIR },
  memories: readMemories(),
  profiles: readProfiles(),
  lightMemory: readLightMemory()
};

if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
fs.writeFileSync(path.join(SNAP_DIR, `${day}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(REPO_DIR, 'latest.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
const pruned = pruneOldSnapshots();

const counts = {
  memories: snapshot.memories.length,
  people: Object.keys(snapshot.profiles.people).length,
  groups: Object.keys(snapshot.profiles.groups).length,
  chats: Object.keys(snapshot.lightMemory).length
};
console.log(`已导出 ${stamp}：记忆 ${counts.memories} 条、人物 ${counts.people}、群 ${counts.groups}、带记忆的会话 ${counts.chats}` + (pruned ? `，清理过期快照 ${pruned} 个` : ''));

if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
  console.error(`备份目录还不是 git 仓库：${REPO_DIR}（先 git clone 私有仓库到这里）`);
  process.exit(1);
}

const status = runGit(['status', '--porcelain']);
if (!status.out) {
  console.log('没有变化，跳过提交。');
  process.exit(0);
}

const add = runGit(['add', '-A']);
if (add.code !== 0) {
  console.error(`git add 失败：${add.out}`);
  process.exit(1);
}
const message = `snapshot ${stamp} (${counts.memories} 条记忆 / ${counts.people} 人物 / ${counts.groups} 群)`;
const commit = runGit(['commit', '-m', message]);
if (commit.code !== 0) {
  console.error(`git commit 失败：${commit.out}`);
  process.exit(1);
}
console.log(`已提交：${message}`);

if (NO_PUSH) {
  console.log('--no-push：跳过推送。');
  process.exit(0);
}

const push = runGit(['push', 'origin', 'HEAD']);
if (push.code !== 0) {
  console.error(`git push 失败：${push.out}`);
  process.exit(1);
}
console.log('已推送到远端。');