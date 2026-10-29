#!/usr/bin/env node
/**
 * 让「模型不支持图片输入」时自动降级成 OCR 文字投递，不再把注定被 DSH 拒绝的图片塞进 prompt。
 *
 * 背景：阿里百炼（alibaifan）通道的 deepseek-v4.1-flash 在 DSH 模型目录里没有声明
 * inputModalities/input 含 image，带 image content part 的 session/prompt 会直接报
 *   model "<model>" does not declare image input
 * 于是 bot 只能拿到一行错误，用户看到的就是「识图报错、只能用 OCR」。
 *
 * 做法：
 *  1) noVisionModels 集合（持久化到 config.json 的 dsh.visionUnsupported）；
 *  2) 撞到这类错误时记下、把这一条消息重建为「OCR 文字 + 纯文本」并重投一次；
 *  3) 之后同一模型一律走 OCR 文字，不再触发报错。
 *
 * 幂等：每处锚点先检查是否已打过。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const file = path.join(ROOT, 'src', 'bridge.js');
const src = fs.readFileSync(file, 'utf8');
let out = src;
const applied = [];
const skipped = [];

function replaceOnce(label, from, to) {
  if (!out.includes(from)) {
    if (out.includes(to)) { skipped.push(label); return; }
    throw new Error(`锚点没找到：${label}`);
  }
  out = out.replace(from, to);
  applied.push(label);
}

// ── 1. 集合声明 ────────────────────────────────────────────────────────────
replaceOnce(
  'noVisionModels 声明',
  `  const noEffortModels = new Set(); // \`\${provider}/\${model}\`
  for (const item of (Array.isArray(cfg.dsh?.effortUnsupported) ? cfg.dsh.effortUnsupported : [])) {
    noEffortModels.add(String(item));
  }
`,
  `  const noEffortModels = new Set(); // \`\${provider}/\${model}\`
  for (const item of (Array.isArray(cfg.dsh?.effortUnsupported) ? cfg.dsh.effortUnsupported : [])) {
    noEffortModels.add(String(item));
  }
  // 有些第三方通道（阿里百炼 alibaifan 等）的模型在 DSH 目录里没有声明 image 输入能力，
  // 带图片的 session/prompt 会被 DSH 直接拒绝：\`model "..." does not declare image input\`。
  // 撞到过的 provider/model 记在这里（并持久化到 config.json 的 dsh.visionUnsupported），
  // 之后这类模型一律改走「OCR 取字 + 纯文本」投递，不再把注定被拒的图片塞进去。
  const noVisionModels = new Set(); // \`\${provider}/\${model}\`
  for (const item of (Array.isArray(cfg.dsh?.visionUnsupported) ? cfg.dsh.visionUnsupported : [])) {
    noVisionModels.add(String(item));
  }
`
);

// ── 2. rememberNoVisionModel + currentChatModelKey ──────────────────────────
replaceOnce(
  'rememberNoVisionModel',
  `      log(\`记住「\${modelKey} 不支持思考强度」失败（本次运行内仍然生效）：\${error?.message ?? error}\`);
    }
  }
`,
  `      log(\`记住「\${modelKey} 不支持思考强度」失败（本次运行内仍然生效）：\${error?.message ?? error}\`);
    }
  }
  /** 当前 bot 使用的 provider/model（每个 DSH 会话首次使用时按 config.json 应用）。 */
  function currentChatModelKey() {
    return \`\${cfg.dsh?.provider ?? ''}/\${cfg.dsh?.model ?? ''}\`;
  }
  /** 这条通道不吃图片输入：记进 config.json，重启后仍然生效。 */
  function rememberNoVisionModel(modelKey) {
    if (!modelKey || noVisionModels.has(modelKey)) return;
    noVisionModels.add(modelKey);
    try {
      const configFile = path.join(ROOT, 'config.json');
      const configObject = readConfigObject(configFile);
      const list = Array.isArray(configObject.dsh?.visionUnsupported) ? configObject.dsh.visionUnsupported.map(String) : [];
      if (!list.includes(modelKey)) {
        configObject.dsh = { ...(configObject.dsh ?? {}), visionUnsupported: [...list, modelKey] };
        atomicWriteJson(configFile, configObject);
      }
      log(\`模型 \${modelKey} 不支持图片输入：之后只用 OCR 文字理解图片（已记入 config.json 的 dsh.visionUnsupported）\`);
    } catch (error) {
      log(\`记住「\${modelKey} 不支持图片输入」失败（本次运行内仍然生效）：\${error?.message ?? error}\`);
    }
  }
`
);

// ── 3. resolveMediaList 支持 textOnly ──────────────────────────────────────
replaceOnce(
  'resolveMediaList 签名',
  `  async function resolveMediaList(mediaList) {
    const parts = [];`,
  `  async function resolveMediaList(mediaList, { textOnly = false } = {}) {
    const parts = [];`
);

replaceOnce(
  'face 分支 textOnly',
  `      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, \`表情#\${media.faceId ?? index}\`) : null;`,
  `      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (textOnly) {
          // 当前模型看不了图：小表情本来就只能靠名字/描述表达，OCR 也读不出什么。
          parts.push({ type: 'text', text: face.text || \`[表情#\${media.faceId ?? index}]\` });
          continue;
        }
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, \`表情#\${media.faceId ?? index}\`) : null;`
);

replaceOnce(
  '图片分支 textOnly',
  `        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? \`:\${String(media.summary).slice(0, 20)}\` : '';`,
  `        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        if (textOnly) {
          const fallbackLabel = sticker ? \`[表情\${index}]\` : \`[图片\${index}]\`;
          if (!img?.buffer) {
            parts.push({ type: 'text', text: \`\${fallbackLabel}（获取失败）\` });
            continue;
          }
          let note = '';
          try {
            const ocr = await ocrImageBuffer(img.buffer, {
              ext: extFromMime(img.mimeType, img.url),
              timeoutMs: 20000
            });
            const text = ocr?.ok ? String(ocr.text ?? '').trim() : '';
            note = text
              ? \`（当前模型不支持看图，下面是 OCR 识别出的文字：\\n\${text.slice(0, 1200)}）\`
              : '（当前模型不支持看图，这张图里也没识别出文字）';
          } catch (error) {
            note = \`（当前模型不支持看图，OCR 也失败了：\${error?.message ?? error}）\`;
          }
          parts.push({ type: 'text', text: \`\${fallbackLabel}\${note}\` });
          continue;
        }
        const summary = sticker && media.summary ? \`:\${String(media.summary).slice(0, 20)}\` : '';`
);

// ── 4. 投递路径：textOnly 预判 + 撞错重投 ───────────────────────────────────
replaceOnce(
  '投递路径 vision 降级',
  `    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = \`\${accepted.result.error.code}: \${accepted.result.error.message}\`;`,
  `    const chatModelKey = currentChatModelKey();
    const hasMedia = Array.isArray(opts.media) && opts.media.length > 0;
    const baseText = withSlangContext(promptText);
    const buildContent = async (textOnly) => {
      if (!hasMedia) return [{ type: 'text', text: baseText }];
      const parts = await resolveMediaList(opts.media, { textOnly });
      return [{ type: 'text', text: baseText }, ...parts];
    };
    // 这个模型之前就撞过「不支持图片输入」：直接走 OCR 文字，省掉一次注定失败的投递。
    const visionBlocked = noVisionModels.has(chatModelKey);
    let content = await buildContent(visionBlocked);
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    /** DSH 拒绝图片输入的报错文案（因通道而异，宁可放宽一点）。 */
    const looksLikeVisionRejection = (message) =>
      /declare image input|does not (?:declare|support) (?:image|vision)|image input|input_image|image content|multimodal/i.test(String(message ?? ''));
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!hasMedia || visionBlocked || !looksLikeVisionRejection(message)) {
        if (opts.farewell) social.exitingSessions.delete(sessionId);
        throw error;
      }
      // 通道不支持图片：记下来，改成 OCR 文字后重投一次。
      rememberNoVisionModel(chatModelKey);
      content = await buildContent(true);
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    }
    if (!accepted.result.ok && hasMedia && !visionBlocked
        && looksLikeVisionRejection(\`\${accepted.result.error?.code ?? ''} \${accepted.result.error?.message ?? ''}\`)) {
      rememberNoVisionModel(chatModelKey);
      content = await buildContent(true);
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = \`\${accepted.result.error.code}: \${accepted.result.error.message}\`;`
);

if (applied.length === 0) {
  console.log('已是目标状态，无需改动。');
  process.exit(0);
}
fs.writeFileSync(file + '.bak-vision', src, 'utf8');
fs.writeFileSync(file, out, 'utf8');
console.log(`已应用 ${applied.length} 处：${applied.join(' / ')}`);
if (skipped.length) console.log(`已存在跳过：${skipped.join(' / ')}`);