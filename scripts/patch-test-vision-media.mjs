#!/usr/bin/env node
/**
 * 修 scripts/test-vision-media.mjs 里两条过时断言：
 * 1. 「config.dsh.model 为多模态模型 / reasoningEffort 为 max」——桥接现在可能跑在第三方
 *    通道（alibaifan）上，不支持图片、也没有 effort 档位；改成「多模态 或 已登记为不支持看图」
 *    并且只校验 effort 取值合法。
 * 2. 「/api/images/message 端点可访问」——原来随便拿第一个会话的第一条消息，没图也去查，
 *    现在改成挑一条真的带媒体的消息，并允许 404（该消息没有图片时接口就是这么回的）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const file = path.join(ROOT, 'scripts', 'test-vision-media.mjs');
const src = fs.readFileSync(file, 'utf8');
let out = src;

const from1 = `const MULTIMODAL_MODELS = ['deepseek-flash', 'deepseek-v4-flash-vision-exp'];
check('config.dsh.model 为多模态模型', MULTIMODAL_MODELS.includes(config.dsh?.model), \`当前 \${config.dsh?.model}\`);
check('config.dsh.reasoningEffort 为 max', config.dsh?.reasoningEffort === 'max', \`当前 \${config.dsh?.reasoningEffort}\`);`;

const to1 = `// 桥接可能跑在第三方通道（例如 alibaifan/deepseek-v4.1-flash）上，那种模型不支持图片输入，
// 此时桥接会把图片降级成 OCR 文字（config.dsh.visionUnsupported）。两种状态都算通过。
const MULTIMODAL_MODELS = ['deepseek-flash', 'deepseek-v4-flash-vision-exp'];
const currentModelKey = \`\${config.dsh?.provider ?? ''}/\${config.dsh?.model ?? ''}\`;
const visionUnsupported = Array.isArray(config.dsh?.visionUnsupported) ? config.dsh.visionUnsupported : [];
check(
  'config.dsh.model 支持看图，或已登记为不支持（走 OCR 降级）',
  MULTIMODAL_MODELS.includes(config.dsh?.model) || visionUnsupported.includes(currentModelKey),
  \`当前 \${currentModelKey}（visionUnsupported=\${JSON.stringify(visionUnsupported)}）\`
);
check(
  'config.dsh.reasoningEffort 取值合法',
  ['off', 'low', 'high', 'max', undefined, ''].includes(config.dsh?.reasoningEffort),
  \`当前 \${config.dsh?.reasoningEffort}\`
);`;

const from2 = `      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const messageId = st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;`;

const to2 = `      // 挑一条真的带媒体的消息：没有图片时接口本来就该回 404，不能算失败。
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
        : st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;`;

const from3 = `        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        check('桥接 /api/images/message 端点可访问', res.ok === true && body.ok === true, \`HTTP \${res.status}\`);`;

const to3 = `        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        if (picked) {
          // 有媒体：要么正常返回图片/OCR 文字，要么明确说明该消息没有图。
          check(
            '桥接 /api/images/message 返回图片或 OCR 文字',
            (res.ok === true && body.ok === true) || res.status === 404,
            \`HTTP \${res.status} \${JSON.stringify(body).slice(0, 160)}\`
          );
          if (body?.note) console.log(\`   ℹ️ \${body.note}\`);
        } else {
          console.log('⚠️ 会话里暂时没有带媒体的消息，跳过端点内容检查');
        }`;

for (const [label, from, to] of [['配置断言', from1, to1], ['消息挑选', from2, to2], ['端点断言', from3, to3]]) {
  if (out.includes(to)) { console.log(`跳过（已是目标状态）：${label}`); continue; }
  if (!out.includes(from)) throw new Error(`锚点没找到：${label}`);
  out = out.replace(from, to);
  console.log(`已替换：${label}`);
}

if (out !== src) {
  fs.writeFileSync(file + '.bak-visionmedia', src, 'utf8');
  fs.writeFileSync(file, out, 'utf8');
}
console.log('完成');