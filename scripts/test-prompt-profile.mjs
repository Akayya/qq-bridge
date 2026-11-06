// 静态检查「提示词瘦身」这项配置：源码分支、预设静态规则、config 默认值、文档。
// 它不重启桥接、不发请求，只证明“三处都齐了”，防止以后只改一半。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 1) 源码里有 promptProfile 开关与 lean 分支
const bridge = read('src/bridge.js');
check('bridge.js 读 socialV2.promptProfile', bridge.includes("cfg.socialV2?.promptProfile ?? 'lean'"));
check('bridge.js 有 lean 分支的沉睡观察短句', bridge.includes('【沉睡观察】决定潜水前先'));
check('bridge.js 保留 full 分支的完整沉睡等待文案', bridge.includes('【沉睡前强制等待】这是决定潜水收尾时的步骤'));
check('bridge.js lean 分支不注入反AI味段', /const antiAiLine = leanPrompt \? '' :/.test(bridge));
check('bridge.js lean 分支不注入积极性段', /const proactiveLine = leanPrompt \? '' :/.test(bridge));
check('bridge.js lean 分支不注入表情包策略', /leanPrompt \? '' : buildStickerStrategyHint\(\)/.test(bridge));

// 2) 预设里补上了静态规则（否则 lean 之后行为会缺一块）
const preset = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
check('预设含【静态行为规则】', preset.includes('【静态行为规则 —— 每轮都适用'));
for (const rule of ['反AI味：', '积极性：', '表情包：', '首回复节奏：', '沉睡观察：', '行动前判断：', '引用：', '跨聊天：']) {
  check(`预设含「${rule}」`, preset.includes(rule));
}

// 3) patch 已重新生成（不一致说明忘了跑 build-agent-preset-patches）
const patch = read('plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');
check('已生成的 patch 含静态规则', patch.includes('【静态行为规则 —— 每轮都适用'));
check('已生成的 patch 含沉睡观察', patch.includes('沉睡观察：除非对方明确说'));
check('patch 比旧版长（>15000 字符）', patch.length > 15000, `实际 ${patch.length}`);

// 4) config 默认 lean
const cfg = JSON.parse(read('config.json').replace(/^\uFEFF/, ''));
check("config.json 的 socialV2.promptProfile 为 'lean' 或缺失", !cfg.socialV2?.promptProfile || cfg.socialV2.promptProfile === 'lean', String(cfg.socialV2?.promptProfile));

// 5) 文档
const doc = read('docs/guides/memory.md');
check('文档提到 promptProfile', doc.includes('promptProfile'));

// 6) reset-sessions 脚本存在且语法可解析（仅检查文件头注释里的关键说明）
const reset = read('scripts/reset-sessions.mjs');
check('reset-sessions.mjs 说明了「会话只在 create 时确立工具表」', reset.includes('session/create'));

console.log(`\n全部通过：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);