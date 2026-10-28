/**
 * 切换桥接（= QQ 里的 bot）使用的模型与 provider。
 *
 * 用法：
 *   node scripts/set-model.mjs                       # 切到 dsh-our-free-model 的免费 DeepSeek V4.1 Flash
 *   node scripts/set-model.mjs --show                # 看当前配置
 *   node scripts/set-model.mjs our-free-model moonshotai/kimi-k3
 *   node scripts/set-model.mjs deepseek-account deepseek-flash   # 切回原样
 *
 * 改完必须重启桥接：node launch-detached.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const file = path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);

if (args.includes('--show') || args.length === 0) {
  console.log(JSON.stringify({ provider: cfg.dsh?.provider, model: cfg.dsh?.model, reasoningEffort: cfg.dsh?.reasoningEffort }, null, 2));
  if (args.length === 0) {
    console.log('\n（只想看配置就加 --show；只跑这条命令不会改任何东西）');
  }
  process.exit(0);
}

const provider = args[0];
const model = args[1];
if (!provider || !model) {
  console.error('用法：node scripts/set-model.mjs <provider> <model>，或 --show');
  process.exit(1);
}

cfg.dsh = { ...(cfg.dsh ?? {}), provider, model };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(`已写入 config.json：dsh.provider=${provider} dsh.model=${model}（reasoningEffort 保持 ${cfg.dsh.reasoningEffort ?? '未设置'}）`);
console.log('重启桥接后生效：node launch-detached.mjs');
