// ComfyUI 接入的冒烟/回归脚本。
//   node scripts/test-comfy.mjs --smoke    只测「静默拉起 + 出图」（512×512、6 步）
//   node scripts/test-comfy.mjs --unit     只测模板替换/参数校验（不连 ComfyUI）
//   node scripts/test-comfy.mjs            两者都跑（默认）
//
// 需要本机装了 ComfyUI（路径见 config.json 的 comfy 段）；没装时 --smoke 会失败，
// --unit 仍然可用，因此 CI 里可以只跑 --unit。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComfy } from '../src/comfy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const onlyUnit = argv.includes('--unit');
const onlySmoke = argv.includes('--smoke');

let pass = 0;
let fail = 0;
const ok = (name, detail = '') => { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, error) => { fail += 1; console.log(`❌ ${name} — ${String(error?.message ?? error)}`); };

function loadComfyConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const comfy = cfg.comfy ?? {};
  return {
    baseUrl: comfy.baseUrl || 'http://127.0.0.1:8188',
    installDir: comfy.installDir || '',
    python: comfy.python || '',
    workflowDir: path.resolve(ROOT, comfy.workflowDir || 'data/comfy/workflows'),
    workDir: path.resolve(ROOT, comfy.workDir || 'state/comfy'),
    workflow: comfy.workflow || 'anima-turbo',
    autoStart: comfy.autoStart !== false,
    startupTimeoutMs: Number(comfy.startupTimeoutMs) || 240000,
    jobTimeoutMs: Number(comfy.jobTimeoutMs) || 900000,
    logPath: path.join(ROOT, 'logs', 'comfy.log'),
    log: (message) => console.log(`[comfy] ${message}`)
  };
}

async function runUnit() {
  const comfy = createComfy(loadComfyConfig());

  const names = comfy.workflowNames();
  if (names.includes('anima-turbo')) ok('工作流目录里有 anima-turbo'); else bad('工作流目录里有 anima-turbo', names.join(',') || '空');

  const built = comfy.buildPrompt('anima-turbo', { prompt: '1girl, "quoted" 引号测试, back\\slash', seed: 12345, width: 768, height: 512, steps: 8 });
  const nodes = built.prompt;
  if (nodes['11']?.inputs?.text === '1girl, "quoted" 引号测试, back\\slash') ok('提示词里的引号与反斜杠被正确转义'); else bad('提示词转义', JSON.stringify(nodes['11']?.inputs?.text));
  if (nodes['19']?.inputs?.seed === 12345) ok('seed 是数字而不是字符串'); else bad('seed 类型', JSON.stringify(nodes['19']?.inputs?.seed));
  if (nodes['28']?.inputs?.width === 768 && nodes['28']?.inputs?.height === 512) ok('宽高写进 EmptyLatentImage'); else bad('宽高', JSON.stringify(nodes['28']?.inputs));
  if (nodes['19']?.inputs?.steps === 8) ok('步数写进 KSampler'); else bad('步数', JSON.stringify(nodes['19']?.inputs?.steps));
  if (typeof nodes['12']?.inputs?.text === 'string' && nodes['12'].inputs.text.includes('worst quality')) ok('负向提示词有默认值'); else bad('负向提示词默认值', JSON.stringify(nodes['12']?.inputs?.text ?? '').slice(0, 60));
  if (!Object.hasOwn(nodes, '__defaults')) ok('模板里的 __defaults 不会发给 ComfyUI'); else bad('__defaults 泄漏', 'still present');

  // 越界参数要被夹住，而不是把离谱数字送进显卡
  const clamped = comfy.buildPrompt('anima-turbo', { prompt: 'x', width: 99999, height: -5, seed: -1 });
  if (clamped.prompt['28'].inputs.width === 4096 && clamped.prompt['28'].inputs.height === 64) ok('宽高越界被夹到 64~4096'); else bad('宽高夹取', JSON.stringify(clamped.prompt['28'].inputs));
  if (clamped.prompt['19'].inputs.seed === 0) ok('负数 seed 被夹到 0'); else bad('seed 夹取', String(clamped.prompt['19'].inputs.seed));

  let threw = false;
  try { comfy.buildPrompt('not-exist', { prompt: 'x' }); } catch (error) { threw = /模板不存在/.test(error.message); }
  if (threw) ok('模板不存在时给出明确错误'); else bad('模板不存在的错误文案', '没有抛或文案不符');
}

async function runSmoke() {
  const conf = loadComfyConfig();
  const comfy = createComfy(conf);

  const before = await comfy.status({ fresh: true });
  ok('能探测 ComfyUI 状态', before.running ? '已在运行' : `未运行（${before.reason}）`);

  const started = await comfy.ensureRunning();
  ok('ensureRunning 成功', started.started ? `刚拉起（${Math.round(started.elapsedMs / 1000)}s）` : '本来就在跑');

  const startedAt = Date.now();
  const result = await comfy.render({
    workflow: conf.workflow,
    prompt: 'masterpiece, best quality, 1girl, solo, white hair, yellow eyes, soft pastel colors, anime coloring, simple background',
    width: 512,
    height: 512,
    steps: 6,
    filename: 'smoke'
  });
  if (fs.existsSync(result.file) && result.bytes > 1000) ok('出图并落盘', `${path.basename(result.file)} ${Math.round(result.bytes / 1024)} KB，${Math.round((Date.now() - startedAt) / 1000)}s`);
  else bad('出图并落盘', `${result.file} ${result.bytes} 字节`);
}

try {
  if (!onlySmoke) await runUnit();
  if (!onlyUnit) await runSmoke();
} catch (error) {
  bad('脚本执行', error);
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);