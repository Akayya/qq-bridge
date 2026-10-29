# 让模型看图（图片输入）与 OCR 降级

桥接支持两条「看图」通道：

| 通道 | 谁来做 | 依赖 | 说明 |
| --- | --- | --- | --- |
| 原生视觉 | DSH 把图片作为 content part 发给模型 | 模型必须**声明**支持 `image` 输入 | 效果最好，模型自己描述画面 |
| OCR 降级 | 桥接本地 WinRT OCR（`scripts/ocr.ps1`） | Windows 自带简体中文 OCR | 只认文字，认不出画面 |

## 1. 为什么会出现 `does not declare image input`

DSH 的 ACP 层在发 `session/prompt` 之前会校验模型能力：

```js
if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
  throw new AcpContentError(`model "${model}" does not declare image input`, 'invalid');
}
```

`deepseek-account` 的 `deepseek-flash` 内置声明了 `inputModalities: ["text","image"]`；
而通过 `llm-pi-ai` 接的第三方 OpenAI 兼容通道默认 `DEFAULT_INPUT = ["text"]`，
**必须显式声明**，否则带图的 prompt 直接被拒，桥接只能退回 OCR。

## 2. 给第三方通道开图片输入

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里 `llm-pi-ai` 的 provider 定义，给模型加 `input`：

```yaml
  - id: llm-pi-ai
    config:
      providers:
        alibaifan:
          apiKeyEnv: ALIBAIFAN_API_KEY
          api: openai-completions
          baseURL: https://<your-gateway>/compatible-mode/v1
          models:
            - id: deepseek-v4.1-flash
              name: deepseek-v4.1-flash
              input: [text, image]   # ← 这一行
```

改完**重启 DSH** 生效（插件在启动时装配）。可选字段还有 `reasoningEfforts`、`contextWindow`、`maxTokens`、`compat`。

## 3. 同步桥接的黑名单

`config.json` 的 `dsh.visionUnsupported` 是「已知看不了图的模型」列表，格式 `<provider>/<model>`。
通道支持图片后要把它清空，否则桥接仍会把图片转成 OCR 文字：

```powershell
node scripts/seed-vision-unsupported.mjs --remove alibaifan/deepseek-v4.1-flash   # 支持图片了，移出黑名单
node scripts/seed-vision-unsupported.mjs alibaifan/deepseek-v4.1-flash            # 不支持，重新登记
```

## 4. 验证

```powershell
# 直接问模型（不经过 QQ）：生成测试图 → 发一次带图的 prompt
node scripts/probe-vision-alibaba.mjs --image state/vision-test.png --prompt "图里有哪几种颜色？中间那个数字是几？"

# 从 QQ 侧：让 bot 自己取图（MCP 工具）
# qq_get_message_images(key, messageId, token)
```

回归测试：

```powershell
node scripts/test-vision-fallback.mjs   # 降级链路（14 项）
node scripts/test-vision-media.mjs      # 桥接投递与端点（5 项）
```

## 5. 关于 ffmpeg

图片压缩依赖 ffmpeg（`FFMPEG_PATH` 或 `config.json` 的 `socialV2.voice.ffmpegPath`）。
本机已把它统一放在 `tools\ffmpeg\bin\ffmpeg.exe`，配置里对应
`"socialV2": { "voice": { "ffmpegPath": "D:/DSH_QQ_BOT/tools/ffmpeg/bin/ffmpeg.exe" } }`；
重装或换机时跑 `node scripts/setup-ffmpeg.mjs`（从 npm 包取静态构建，比官网快几十倍）。
目录约定见 `docs/guides/FILE_LAYOUT.md`。
没有 ffmpeg 时会出现：

- `[media] 图片N: 压缩失败（找不到 ffmpeg…），按原图提供` —— 原图仍能发，只是没压缩；
- `[media] 图片1 不提供：1.37MB 压不到 1024KB 以内` —— 超过 `socialV2.media.maxModelBytes`（默认 1 MB）的图会被**整张丢弃**。

影响最大的是大图和动图（GIF 抽帧拼接需要 ffmpeg）。
装好 ffmpeg 后把路径写进 `config.json` 的 `socialV2.voice.ffmpegPath` 即可，无需重启桥接以外的改动。