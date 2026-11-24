// 记忆快照：把跨聊天共享记忆（state/memory.db）、人物/群档案（state/profiles.json）
// 和每个会话的轻量记忆（话题/想法/印象）导出成 JSON，提交并推送到私有仓库。
//
// 用法：
//   node scripts/backup-memory.mjs                # 有变化才导出 + commit + push
//   node scripts/backup-memory.mjs --force        # 无视「没变化」强制导出一次
//   node scripts/backup-memory.mjs --no-push      # 只导出
//   node scripts/backup-memory.mjs --dir D:\x     # 指定本地备份仓库目录
//
// 设计取舍：
//   - 只导出「记忆」，不导出 config.json / 会话令牌 / 聊天正文，避免把密钥和别人的私聊顶上云。
//   - **只在记忆内容真的变了时才写文件、提交、推送**：快照里的 generatedAt 每次都不同，
//     所以不能靠 git status 判断有没有变化，得先比内容指纹（state/memory-backup.json 里的 hash）。
//     没变化时脚本 0.05 秒退出，不联网、不写盘。
//   - 每天一个文件（同一天多次运行会覆盖当天文件），保留最近 60 天。
//   - 用 JSON 而不是直接提交 sqlite 文件：文本好 diff、好回收，仓库不会因为二进制膨胀。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
// 0（或负数）= 不清理历史，永久保留每日快照
const KEEP_DAYS = Math.max(0, Number(valueOf('--keep-days', '60')) || 0);
const NO_PUSH = has('--no-push');
const FORCE = has('--force');
const STATE_DIR = path.join(ROOT, 'state');
const SNAP_DIR = path.join(REPO_DIR, 'snapshots');
// 上一次成功上传的内容指纹（放桥接自己的 state 里，不进备份仓库）
const MARKER_FILE = path.join(STATE_DIR, 'memory-backup.json');

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
  if (!KEEP_DAYS) return 0; // 0 = 永久保留
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

// 这台机器上 openssl 后端拿不到 CA（报 unable to get local issuer certificate (20)），
// 而 Windows 自带的 schannel 能正常握手，所以这里显式用 schannel。
const GIT_SSL_ARGS = ['-c', 'http.sslBackend=schannel'];

function runGit(gitArgs) {
  const res = spawnSync('git', [...GIT_SSL_ARGS, ...gitArgs], {
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

// 稳定的 JSON 序列化：对象键排序，保证同样的记忆内容算出同样的指纹
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const memories = readMemories();
const profiles = readProfiles();
const lightMemory = readLightMemory();

// 指纹只覆盖「记忆内容」本身，不覆盖会自然变动的字段：
//   - memory.db 的 used_at / hits：每次召回都会变，但不代表记忆更新了
//   - 轻量记忆的 recentCount / lastIncomingAt：聊天一多就变，同理
// 否则「没更新记忆」也会被判成有变化，又回到每轮都上传。
const fingerprint = crypto
  .createHash('sha256')
  .update(
    stableStringify({
      schema: 1,
      memories: memories.map((m) => ({
        id: m.id,
        kind: m.kind,
        text: m.text,
        tags: m.tags,
        scope: m.scope,
        source_key: m.source_key,
        created_at: m.created_at
      })),
      profiles,
      lightMemory: Object.fromEntries(
        Object.entries(lightMemory).map(([key, st]) => [
          key,
          {
            activeTopics: st.activeTopics,
            pendingThoughts: st.pendingThoughts,
            memberImpressions: st.memberImpressions
          }
        ])
      )
    })
  )
  .digest('hex');

// 内容没变就什么都不做：不写快照、不 commit、不 push、不联网。
// 这一步是必须的——快照里的 generatedAt 每次都不同，光看 git status 永远"有变化"，
// 以前就是这样每 6 小时往 GitHub 顶一次一模一样的记忆。
const marker = readJson(MARKER_FILE, null);
if (!FORCE && marker && marker.hash === fingerprint) {
  const at = marker.at ? new Date(marker.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知时间';
  console.log(`记忆没有变化（${memories.length} 条记忆，上次上传 ${at}），跳过。`);
  process.exit(0);
}

const snapshot = {
  schema: 1,
  generatedAt: now.toISOString(),
  source: { stateDir: STATE_DIR },
  memories,
  profiles,
  lightMemory
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

const writeMarker = () => {
  fs.writeFileSync(
    MARKER_FILE,
    `${JSON.stringify({ hash: fingerprint, at: now.toISOString(), counts }, null, 2)}\n`,
    'utf8'
  );
};

const status = runGit(['status', '--porcelain']);
if (!status.out) {
  writeMarker();
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
writeMarker();
console.log(`已推送到远端；记下内容指纹 ${fingerprint.slice(0, 12)}（下次记忆没变就不来了）。`);