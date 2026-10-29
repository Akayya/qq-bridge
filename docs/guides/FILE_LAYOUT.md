# 目录与文件约定

桥接在 `D:/DSH_QQ_BOT` 下自成一个完整部署，所有东西都在这一个目录里（除了 DSH 侧的 profile 与 SnowLuma 本体）。文档里统一用正斜杠写路径——Node 与 ffmpeg 在 Windows 上都认，`config.json` 里也是这么写的。

```
D:/DSH_QQ_BOT/
├─ src\                 程序源码（bridge.js、各功能模块、MCP server）
├─ scripts\             运维与测试脚本（test-*.mjs、patch-*.mjs、probe-*.mjs）
├─ dsh\                 DSH 侧资源：agent-presets\（QQ 会话预设）、consoles\
├─ plugins\             DSH 插件源码（qq-agent-presets / qq-mode-console，被 junction 进 ~/.dsh）
├─ public\              控制台单文件页面（console.html + assets），改完刷新即生效
├─ docs\                文档（guides\ 实用指南、audits\ 审计结论）
├─ roles\               角色卡（人设 markdown，改完热生效）
├─ state\               运行时状态，**不要手改**（桥接运行时会覆盖）
│   ├─ memory.db            共享记忆 SQLite（含向量列）
│   ├─ profiles.json        人物/群档案
│   ├─ persona-growth.json  人设成长条目（+ .jsonl 审计日志）
│   ├─ social-v2.json       会话窗口、轻量记忆、唤醒配置
│   ├─ sessions.json        会话 key → DSH sessionId
│   ├─ nekowhale\           自带表情包缓存（按需下载）
│   └─ *.log / *.jsonl      桥接日志与用量记录（滚动保留）
├─ data\                长期数据资产（可重建但重建成本高）
│   ├─ memewiki\            梗百科词库
│   └─ models\              向量模型缓存（bge-small-zh q8，23 MB）
├─ audio\               语音库（发语音用）
├─ logs\                运行日志（bridge.out.log / bridge.err.log / autostart.log）
├─ backups\             备份快照，**不进代码库**
│   ├─ config\              config.json.bak-*
│   ├─ state\               状态文件快照
│   ├─ patches-archive\     历史补丁脚本（已被正式改动取代）
│   └─ qq-bridge-old-*\     迁移前旧目录的关键文件
├─ tools\               外部二进制，**不进代码库**
│   └─ ffmpeg\bin\ffmpeg.exe   图片压缩 / 动图抽帧
├─ vendor\              第三方 npm 依赖（隔离安装，**不进代码库**）
│   └─ embeddings\node_modules\@huggingface\transformers
├─ third-party\         上游源码克隆（memewiki、表情包），只读参考
└─ node_modules\        主依赖
```

## 哪些目录不要提交、不要手改

| 路径 | 规矩 |
| --- | --- |
| `state\` | 运行时状态，桥接运行时会被内存数据覆盖；要改先停桥接 |
| `data\models\`、`state\nekowhale\`、`vendor\`、`tools\` | 可重建的缓存/依赖/二进制，已在 `.git/info/exclude` 里排除 |
| `backups\`、`third-party\` | 隐私快照与上游源码，同样排除 |
| `logs\`、`state\*.log`、`state\*.jsonl` | 排障用，可随时删 |

## ffmpeg

图片压缩（`socialV2.media`）与动图抽帧拼接依赖 ffmpeg，路径写在 `config.json`：

```json
"socialV2": { "voice": { "ffmpegPath": "D:/DSH_QQ_BOT/tools/ffmpeg/bin/ffmpeg.exe" } }
```

也可用环境变量 `FFMPEG_PATH` 覆盖。没有 ffmpeg 时的表现见 `docs/guides/VISION_INPUT.md` 第 5 节
（小图按原图发送、超过 `maxModelBytes` 的图被丢弃、动图只给首帧）。

## 换机器/重装时的最小集合

必须带的：`src\ scripts\ dsh\ plugins\ public\ docs\ roles\ config.json package.json pnpm-lock.yaml`
+ `state\`（记忆与档案都在里面）+ `data\`（词库与模型缓存，模型可重新下载）。

可以不带：`vendor\ tools\ logs\ backups\ third-party\ state\models\ state\nekowhale\`
（`vendor` 用 `pnpm install` 在 `vendor\embeddings` 里重装，`tools\ffmpeg` 重新下，模型首次使用会重下）。