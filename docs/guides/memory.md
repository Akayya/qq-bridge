# 跨聊天共享记忆（本分支新增）

桥接默认只有「每个会话各记各的」的轻量记忆（`state/social-v2.json` 里的 `activeTopics` / `pendingThoughts` / `memberImpressions`）。这个分支加了一层**跨聊天、可检索、可备份**的长期记忆，以及人物/群档案和自动提炼。

## 三块能力

### 1. 共享记忆（SQLite + FTS5）
- `src/shared-memory.js`：`createSharedMemory({dbPath, ownerQQ, log, sanitize, isSensitive})`
- 库：`state/memory.db`，表 `memories(id, kind, text, tags, scope, source_key, created_at, used_at, hits)`，
  外加 `memories_fts`（FTS5 外部内容表，`tokenize='trigram'`，由触发器同步）。
- `kind`：`fact` / `preference` / `bond` / `rule`
- `scope`（可见范围）：
  - `all` —— 所有聊天可见，**只有管理员私聊能写**
  - `groups` —— 所有群可见，私聊不可见
  - `owner` —— 只有管理员私聊可见
  - `key:<会话 key>` —— 只有那个会话可见（默认）
- 唤醒时注入：最多 20 条 / 800 字，按 `used_at` LRU；另外会按最近来信做一次「内容字重合度」匹配，命中则额外注入一段【相关记忆】。
- 检索：`search(q, {key})`——中文 ≥3 字走 FTS5 trigram，1~2 字回退 `LIKE`，结果仍按 scope 过滤。

### 2. 人物与群档案
- `src/profiles.js` → `state/profiles.json`
- `people[qq] = {name, aliases[], traits[], facts[], sourceKey, updatedAt}`
- `groups[gid] = {name, summary[], members[{qq,name}], updatedAt}`
- 注入规则：私聊注入对方档案；群里注入群档案 + 最近发言者中至多 3 人的档案。

### 3. 自动提炼
- `src/memory-distill.js` → 从最近的来信里按规则挑句子（偏好 / 关系 / 约定），`fact` 只进预览不自动写。
- 桥接里由 `startMemoryDistillLoop()` 定时跑（默认每 30 分钟扫一次，只处理「安静 ≥90 分钟且上次提炼后有新来信」的会话），每次最多写 2 条。
- 配置：`config.json` → `memory.autoDistill { enabled, intervalMinutes, idleMinutes }`。

## HTTP 接口（都由 `x-agent-token` 的「本会话令牌」或「管理员令牌 + 白名单校验」保护）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/socialV2/memory-global` | 写一条共享记忆（`key/text/kind/scope/tags`） |
| GET | `/api/socialV2/memory-global?key=&q=&limit=` | 读（按 scope 过滤；有 `q` 走检索） |
| GET | `/api/socialV2/memory-global?all=1` | **仅控制台**：全库 + 统计（智能体调用返回 403） |
| POST | `/api/socialV2/memory-global-remove` | 删除（`id` 或 `text`；管理页可跨会话） |
| POST | `/api/socialV2/profile` | 人物/群档案 `op=get|update|remove` |
| GET | `/api/socialV2/profiles?key=` | 看某会话会注入的档案文本 |
| POST | `/api/socialV2/memory-distill` | 触发提炼（默认只预览，`apply:true` 才写） |
| GET | `/api/socialV2/prompt-preview?key=` | 排查用：看这个会话实际的唤醒提示词 |

## MCP 工具
`qq_memory_append`（`category=global` + `scope`/`kind`/`tags`）、`qq_memory_query`（`category=global` + `q`）、
`qq_memory_remove`（`category=global` + `id`）、`qq_profile`、`qq_memory_distill`。

## 控制台
`public/console.html` 新增「记忆与档案」页：全库列表 + 搜索/按 kind·scope 筛选 + 手动添加 + 一键提炼（可预览/写回）+ 档案编辑。

## 备份
`scripts/backup-memory.mjs`（配合 `scripts/backup-memory.cmd` 给计划任务用）把上面的记忆导出成 JSON，
提交并推送到**私有**仓库；只导记忆，不导 `config.json`、会话令牌和聊天正文。

```bash
node scripts/backup-memory.mjs              # 导出 + commit + push
node scripts/backup-memory.mjs --no-push    # 只导出
node scripts/backup-memory.mjs --dir D:\x   # 指定本地仓库目录（默认 D:\DSH_MEMORY_BACKUP）
node scripts/backup-memory.mjs --keep-days 0 # 不清理历史快照（默认保留 60 天）
```

> 清理只删「每日历史快照文件」，`latest.json` 永远是最新全量；记忆本身在 `state/memory.db` 里不受影响。

## 测试
```bash
node scripts/test-shared-memory.mjs      # 共享记忆：单测 + HTTP 端到端
node scripts/test-profiles-distill.mjs   # 档案 + 提炼
node scripts/test-mcp-servers-stdio.mjs  # 三个 MCP server 接入 + 记忆查询实调用
```