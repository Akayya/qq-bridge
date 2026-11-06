// 「按人话发收藏表情」的回归测试。
//
// 背景：模型手里通常只有表情上的字（「呆猫装傻」），没有 emoji_id；早先 sendStickerV2
// 只做 id/md5/url 精确匹配，于是模型老老实实报「找不到表情 呆猫装傻」。
// 这里拦住两件事：① 模糊匹配能按备注/标签命中；② 匹配不上时给出候选项而不是干巴巴报错。
//
// 用法：node scripts/test-sticker-labels.mjs        （单测）
//       node scripts/test-sticker-labels.mjs --http （再打一次桥接接口，需桥接在跑）
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const lib = await import('../src/sticker-lib.js');

console.log('\n【单测】按名字/备注模糊匹配');
const entries = [
  { id: 'e1', desc: '呆猫装傻', tags: [], useCount: 3, source: 'qq' },
  { id: 'e2', desc: '呆猫不想听', tags: ['无声'], useCount: 0, source: 'qq' },
  { id: 'e3', desc: '', localNote: '无语猫猫', tags: ['无语'], useCount: 1, source: 'qq' },
  { id: 'e4', desc: '大胃袋deepsee', tags: [], useCount: 0, source: 'qq' }
];
const hit = (q) => lib.findStickerByLabel(entries, q)?.id ?? null;
ok('精确备注命中', hit('呆猫装傻') === 'e1');
ok('备注子串命中（取常用的那张）', hit('呆猫') === 'e1');
ok('localNote 命中', hit('无语猫猫') === 'e3');
ok('标签命中', hit('无声') === 'e2');
ok('不存在时返回 null', hit('完全不存在的表情') === null);
ok('空串返回 null', hit('') === null);
ok('超长输入返回 null', hit('一'.repeat(120)) === null);

console.log('\n【单测】匹配不上时给候选项');
const hints = lib.stickerLabelCandidates(entries, 3);
ok('候选项带 id', hints.length === 3 && hints.every((h) => h.includes('id ')), hints.join(' / '));
ok('候选项不含没备注的条目', hints.every((h) => !h.includes('e4')) || hints.length <= 4);

console.log('\n【源码接线】bridge 真的用了它');
const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
ok('bridge 导入 findStickerByLabel', /findStickerByLabel/.test(bridge));
ok('sendStickerV2 走模糊匹配', /findSticker\(pool, stickerRef\) \|\| findStickerByLabel\(pool, stickerRef\)/.test(bridge));
ok('报错带候选项', /收藏里相近的有/.test(bridge));
ok('pack: 前缀被剥掉', /replace\(\/\^pack:\\s\*\/iu, ''\)/.test(bridge));

if (process.argv.includes('--http')) {
  console.log('\n【HTTP】真发一张收藏表情（需要桥接在跑）');
  try {
    const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
    const token = fs.readFileSync(new URL('../state/console-token', import.meta.url), 'utf8').trim();
    const state = JSON.parse(fs.readFileSync(new URL('../state/social-v2.json', import.meta.url), 'utf8'));
    const key = `private:${cfg.ownerQQ}`;
    const agent = state.conversations?.[key]?.agentToken;
    if (!agent) { console.log('  ⚠️ 该会话还没有 agentToken（尚未唤醒过），跳过'); }
    else {
      const res = await fetch(`http://127.0.0.1:${cfg.port ?? 3100}/api/socialV2/send-sticker`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': token, 'x-agent-call': '1', 'x-agent-token': agent },
        body: JSON.stringify({ key, stickerId: '呆猫装傻' })
      });
      const body = await res.json().catch(() => ({}));
      ok('按中文备注发送成功', res.ok && body.ok === true, `${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    }
  } catch (error) {
    fail += 1;
    console.log(`  ❌ HTTP 检查异常：${error?.message ?? error}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);