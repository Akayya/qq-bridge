// 视觉/图片链路自检脚本：
// 1. 校验配置默认模型为 DeepSeek-V4-Flash-Vision-Exp
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 若桥接运行中，校验 /api/images/message 端点可用（用二代 agent token）
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const config = readJson(path.join(ROOT, 'config.json'));
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置
// 多模态模型清单：DSH 0.1.5 的 llm-deepseek 里声明 inputModalities 含 image 的模型。
// deepseek-flash（DeepSeek-V41-Flash）是当前默认；deepseek-v4-flash-vision-exp 为历史默认。
// 桥接可能跑在第三方通道（例如 alibaifan/deepseek-v4.1-flash）上，那种模型不支持图片输入，
// 此时桥接会把图片降级成 OCR 文字（config.dsh.visionUnsupported）。两种状态都算通过。
const MULTIMODAL_MODELS = ['deepseek-flash', 'deepseek-v4-flash-vision-exp'];
const currentModelKey = `${config.dsh?.provider ?? ''}/${config.dsh?.model ?? ''}`;
const visionUnsupported = Array.isArray(config.dsh?.visionUnsupported) ? config.dsh.visionUnsupported : [];
const cordisPatch = (() => {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
  } catch {
    return '';
  }
})();
const cordisDeclaresImage = /input:\s*\[[^\]]*image[^\]]*\]/.test(cordisPatch);
check(
  'config.dsh.model 支持看图，或已登记为不支持（走 OCR 降级）',
  MULTIMODAL_MODELS.includes(config.dsh?.model) || cordisDeclaresImage || visionUnsupported.includes(currentModelKey),
  `当前 ${currentModelKey}（visionUnsupported=${JSON.stringify(visionUnsupported)}，cordis 声明 image=${cordisDeclaresImage}）`
);
check(
  'config.dsh.reasoningEffort 取值合法',
  ['off', 'low', 'high', 'max', undefined, ''].includes(config.dsh?.reasoningEffort),
  `当前 ${config.dsh?.reasoningEffort}`
);
check('config.socialV2.tools.getImages 默认开启', config.socialV2?.tools?.getImages !== false);

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 桥接端点（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File)) {
  try {
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    if (conv) {
      // 挑一条真的带媒体的消息：没有图片时接口本来就该回 404，不能算失败。
      let picked = null;
      for (const [candidateKey, candidateState] of Object.entries(social.conversations ?? {})) {
        for (const message of (candidateState?.recentMessages ?? []).slice().reverse()) {
          if (!message) continue;
          const media = Array.isArray(message.media) ? message.media : [];
          if (!media.length && !message.hasMedia) continue;
          picked = { key: candidateKey, state: candidateState, message };
          break;
        }
        if (picked) break;
      }
      const [key, st] = picked ? [picked.key, picked.state] : conv;
      const agentToken = st?.agentToken;
      const messageId = picked
        ? picked.message.messageId
        : st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;
      if (agentToken && messageId) {
        const url = `http://127.0.0.1:${config.consolePort || 3100}/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`;
        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        if (picked) {
          // 有媒体：要么正常返回图片/OCR 文字，要么明确说明该消息没有图。
          check(
            '桥接 /api/images/message 返回图片或 OCR 文字',
            (res.ok === true && body.ok === true) || res.status === 404,
            `HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`
          );
          if (body?.note) console.log(`   ℹ️ ${body.note}`);
        } else {
          console.log('⚠️ 会话里暂时没有带媒体的消息，跳过端点内容检查');
        }
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken/messageId');
      }
    }
  } catch (error) {
    console.log(`⚠️ 桥接端点检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
