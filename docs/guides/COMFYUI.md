# 本机出图（ComfyUI）

让 QQ 里的 bot 直接调用本机 ComfyUI 画图并发进当前会话。**不需要**先打开绘世启动器：
桥接发现 8188 没开就会自己静默拉起（`windowsHide`，不弹窗口）。

## 一次完整调用长什么样

```
bot: qq_comfy_draw(prompt="…", width=1024, height=1024)
  → POST /api/comfy/draw（带会话令牌）
    → ensureRunning()：8188 没开就 spawn python main.py --port 8188 --listen 127.0.0.1
    → buildPrompt()：把 {{prompt}} / {{seed}} 等替换成真实值
    → POST /prompt → 轮询 GET /history/<id> → GET /view 取图
    → 存 state/comfy/*.png → 发进会话（图片消息）
```

默认 768×768 时 RTX 5070 Laptop 上约 5 秒一张（模型已热）；冷启动 ComfyUI 约 90~100 秒，
所以第一次调用要给它一两分钟。

## 配置（config.json）

```json
"comfy": {
  "enabled": true,
  "baseUrl": "http://127.0.0.1:8188",
  "installDir": "D:/ComfyUI-aki-v3.2/ComfyUI-aki-v3.2/ComfyUI",
  "python": "D:/ComfyUI-aki-v3.2/ComfyUI-aki-v3.2/python/python.exe",
  "workflowDir": "data/comfy/workflows",
  "workDir": "state/comfy",
  "workflow": "anima-turbo",
  "autoStart": true,
  "startupTimeoutMs": 240000,
  "jobTimeoutMs": 900000
}
```

- `autoStart: false` → 只连不拉，8188 没开就报错（适合你自己用绘世启动器开 GPU 配置的时候）。
- `workflow` 是默认模板名，不带 `.json`。
- 关掉整个功能：`enabled: false`，或控制台里把 `qq_comfy_*` 工具关掉（`socialV2.tools.comfy`）。

## HTTP / MCP 面

| HTTP | MCP 工具 | 作用 |
|---|---|---|
| `GET /api/comfy/status` | `qq_comfy_status` | 是否在线、显卡、队列是否忙 |
| `GET /api/comfy/workflows` | `qq_comfy_workflows` | 模板列表 + 默认参数 |
| `POST /api/comfy/draw` | `qq_comfy_draw` | 出图（默认直接发进会话） |
| `POST /api/comfy/cancel` | `qq_comfy_cancel` | 中断当前任务 |

`/api/comfy/draw` 的 body：`{key, prompt, negative?, width?, height?, steps?, seed?, workflow?, send?}`。
同一次只允许一个任务，忙时返回 409 并带上一张的开始时间与提示词。

## 加一个工作流

1. 在 ComfyUI 里把工作流调好 → 菜单里 **Export (API)**，得到 API 格式 JSON（不是普通保存的 UI 格式）。
2. 放到 `data/comfy/workflows/<名字>.json`，把要外部控制的字段换成占位符：`{{prompt}}`、`{{negative}}`、
   `{{seed}}`、`{{width}}`、`{{height}}`、`{{steps}}`、`{{cfg}}`、`{{filename}}`。
   **数字占位符要写成带引号的字符串**（`"{{seed}}"`），否则 JSON 解析就失败；`src/comfy.js` 会按字段名
   （seed/steps/width/height/cfg/denoise…）在替换后还原成数字。
3. 可选加 `"__defaults": { "steps": 10, "cfg": 1, "negative": "..." }` 作为默认值（解析后会被删掉，不下发）。
4. 调用时 `workflow: "<名字>"`。

## 现有模板

| 模板 | 模型 | 说明 |
|---|---|---|
| `anima-turbo` | `anima-turbo-v1.1` + `qwen_3_06b_base` + `qwen_image_vae` | 动漫风，turbo 10 步、cfg 1、`er_sde`，1024² 默认 |

同一套 ComfyUI 里还有 `Z-Image-Turbo`、`Wan2.2-TI2V-5B` 的现成工作流（在 `user/default/workflows`），
要用就按上面的步骤导出成 API 格式再加占位符。

## 排查

- **一直转圈**：`logs/comfy.log` 是 ComfyUI 自己的输出；`logs/bridge.out.log` 里搜 `[comfy]` 看是哪一步。
- **显存不够**（8 GB 卡）：把尺寸降到 768 或 512，或 `steps` 降到 6~8；anima-turbo 对步数很宽容。
- **换了模型/量化目录**：改 `config.json` 的 `installDir`/`python`，然后重启桥接。
- **想让它别自动开**：`autoStart: false`，自己用绘世启动器开（能选显存策略、开 xformers 之类）。

## 测试

```bash
node scripts/test-comfy.mjs --unit   # 纯静态：模板与占位符替换，不碰 GPU
node scripts/test-comfy.mjs --smoke  # 真跑一张 512×512（会拉起 ComfyUI，约 1~2 分钟）
```