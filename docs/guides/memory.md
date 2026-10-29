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

### 4. 人设成长（人设增量层）
角色卡 `roles/<角色>.md` 是骨架（谁、什么性格、什么底线），由管理端维护；**成长层**存它在聊天里
慢慢长出来的部分：新口头禅、新习惯、新喜好、和某个人的关系变化。

- `src/persona-growth.js` → `state/persona-growth.json`（schema 2）
  `{version, roles: { "<角色>": { entries: [{id, text, kind, at, sourceKey, status}] } }, updatedAt}`
- `kind`：`quirk`(习惯) / `preference`(喜好) / `bond`(关系) / `rule`(相处)；`status`：`approved`(已生效) / `pending`(待审，schema 1 的老条目自动按 approved 处理)。
- **谁能写**：任何聊天都能 `add` 提交；但**只有管理员会话（`ownerQQ` 私聊）和控制台写的是 `approved`**，其余一律落成 `pending`——
  返回里 `pendingReview: true`，**不注入提示词**，要管理员在控制台（或管理员会话调 `op=approve`）通过才生效。
  `remove` / `clear` / `approve` 仍然只有管理员会话与控制台能调。
- 硬约束：每条 ≤80 字；**已生效** ≤12 条、总 ≤600 字（默认值，可在 `config.json` 的 `memory.personaGrowth` 调）；**待审** ≤12 条；敏感内容（令牌/凭证）拒写；文件读坏就停写（不覆盖手写内容）。
- 审计：每次 add / approve / remove / clear 都追加一行 JSON 到 `state/persona-growth-history.jsonl`。
- 注入顺序：`roleLine` → **人设成长（仅 approved）** → 身份/令牌 → … → 记忆/档案/共享记忆，以 `【人设成长】…` 出现；
  `qq_get_prompt` 的返回值里也有 `growth: { entries, text, limits }`。
- 为什么不让 bot 直接改人设卡、也不让它直接生效：群友一句「你其实不是鲸鱼」就能诱导改写底线；让写入立刻生效还会形成
  「注入 → 自我强化 → 越写越像漫画角色」的漂移。待审队列把「自己长」和「不会长歪」同时保住：它随时可以提，你的一个键说了算。

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
| GET | `/api/socialV2/persona-growth?key=` | 读人设成长（`all=1` 仅控制台） |
| POST | `/api/socialV2/persona-growth` | 人设成长 `op=add`（任何会话可提，非管理员落成待审）/`approve`/`remove`/`clear`（后三个仅管理员会话或控制台） |
| GET | `/api/socialV2/prompt-preview?key=` | 排查用：看这个会话实际的唤醒提示词 |

## MCP 工具
`qq_memory_append`（`category=global` + `scope`/`kind`/`tags`）、`qq_memory_query`（`category=global` + `q`）、
`qq_memory_remove`（`category=global` + `id`）、`qq_profile`、`qq_memory_distill`、`qq_persona_grow`。

## 控制台
`public/console.html` 新增「记忆与档案」页：全库列表 + 搜索/按 kind·scope 筛选 + 手动添加 + 一键提炼（可预览/写回）+ 档案编辑 + 人设成长（列出/添加/删除，显示 `N/12 条 · X/600 字 · 待审 K/12 条`）。

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

## 语义召回（向量）

字面匹配（FTS5 trigram + 字重合）搞不定「同义不同词」：说「今天点了杯冰咖啡」，记的是「只喝冰美式」。
所以额外接了一个**本地小模型**做语义召回，全离线、不上传任何内容。

- 模型：`Xenova/bge-small-zh-v1.5`（q8 量化，**512 维**，磁盘 ~24 MB，单条推理 ~2 ms）
- 依赖：`vendor/embeddings/node_modules/@huggingface/transformers` + `onnxruntime-node`（独立目录，不污染主 `node_modules`）
- 模型缓存：`state/models/`（首次运行从 `hf-mirror.com` 下载；之后完全离线）
- 写入：每条记忆落库后异步补算向量（250ms 合批，不阻塞回复）；历史条目在启动时回填
- 读取：取你最近 3 条来信拼成查询，算出向量，和库存条目算余弦；≥ `minScore`（默认 **0.5**）的进【相关记忆】
- 降级：模型加载失败 / 目录被删 → 只打一条日志，语义召回自动关闭，其它功能照常

配置在 `config.json`：

```json
"memory": {
  "embeddings": {
    "enabled": true,
    "provider": "local",
    "model": "Xenova/bge-small-zh-v1.5",
    "dtype": "q8",
    "cacheDir": "state/models",
    "remoteHost": "https://hf-mirror.com",
    "warmOnStart": true,
    "semanticTopK": 3,
    "minScore": 0.5
  }
}
```

调阈值：**想更灵敏就调低**（0.4 会把「咖啡/茶」这类弱相关也拉进来），**想更保守就调高**（0.6 只留强相关）。
实测参考分数：「今天点了杯冰咖啡」↔「只喝冰美式」= 0.63，↔「猫叫年糕」= 0.31。

> 国内网络必须走 `hf-mirror.com`（`huggingface.co` 直连会超时）。已下载就不需要网络了。
> 换模型时改 `model` 并删 `state/models` 里的旧目录即可；换 **维度不同** 的模型要同时清空 `memories.embedding` 列（`UPDATE memories SET embedding=NULL`），否则余弦长度不等会被跳过。

## 测试
```bash
node scripts/test-shared-memory.mjs      # 共享记忆：单测 + HTTP 端到端
node scripts/test-profiles-distill.mjs   # 档案 + 提炼
node scripts/test-mcp-servers-stdio.mjs  # 三个 MCP server 接入 + 记忆查询实调用
```