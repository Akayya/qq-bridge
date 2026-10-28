// 大肥鱼表情包接入层自检（src/nekowhale.js）。
// 1) 纯函数：URL 归类、噪声行清理、插件目录候选
// 2) digest 集成用例：需要 dsh-nekowhale-stickers 已装（否则整段跳过）+ 能连上表情 CDN
//
// 用法：node scripts/test-nekowhale-bridge.mjs
// 离线跑纯函数：NEKOWHALE_OFFLINE=1 node scripts/test-nekowhale-bridge.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyImage,
  cleanupStickerText,
  localPathFromUrl,
  pluginCandidates,
  resolvePluginDir,
  createNekowhaleStickers,
  readStickerFile,
  MAX_STICKERS_PER_REPLY,
  PLUGIN_PACKAGE_NAME
} from '../src/nekowhale.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'tmp-neko-testdata');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## 纯函数');
{
  ok(localPathFromUrl('file:///C:/a/b.gif')?.toLowerCase().endsWith('b.gif'), 'file:// URL 还原成本地路径');
  ok(localPathFromUrl('C:\\a\\b.gif') === 'C:\\a\\b.gif', 'Windows 绝对路径原样返回');
  ok(localPathFromUrl('https://x/a.gif') === null, 'http URL 不当成路径');
  ok(localPathFromUrl('') === null, '空串返回 null');
}
{
  const s = classifyImage('摸鱼', 'http://127.0.0.1:60019/nekowhale/s/abcdef123456.gif');
  ok(s?.kind === 'hash' && s.key === 'abcdef123456' && s.alt === '摸鱼', '/s/<hash>.gif 归为 hash');
  const r = classifyImage('标题', 'http://127.0.0.1:60019/nekowhale/r/r_9.gif?x=1');
  ok(r?.kind === 'render' && r.key === 'r_9', '/r/<id>.gif 归为 render');
  ok(classifyImage('x', 'https://example.com/a.png') === null, '普通图片不在表情路由上，保持原样');
  ok(classifyImage('x', 'C:/tmp/a.gif')?.kind === 'local', '本地图片路径归为 local');
}
{
  const text = ['好耶', '把上面这行原样放进回复即可显示。', '', '', '', '收'].join('\n');
  const cleaned = cleanupStickerText(text);
  ok(!cleaned.includes('把上面这行原样放进回复即可显示'), '插件那句说明被删掉');
  ok(cleaned.startsWith('好耶') && cleaned.endsWith('收'), '正文首尾保留');
  ok(!/\n{3,}/.test(cleaned), '连续空行压成一行');
}
{
  const candidates = pluginCandidates({ dshHome: 'C:/dsh-home', profile: 'desktop' });
  ok(candidates[0].includes(PLUGIN_PACKAGE_NAME) && candidates[0].includes(path.join('profiles', 'desktop')), '首选 profile/node_modules');
  ok(candidates.at(-1).includes(PLUGIN_PACKAGE_NAME), '最后兜底 ~/.dsh/node_modules');
}

const offline = process.env.NEKOWHALE_OFFLINE === '1';
const installed = resolvePluginDir({ profile: 'desktop' });
if (!installed) {
  console.log(`\n⚠️ 跳过 digest 集成用例：没找到 ${PLUGIN_PACKAGE_NAME}（先 dsh plugin --profile desktop add ${PLUGIN_PACKAGE_NAME}）`);
} else if (offline) {
  console.log('\n⚠️ NEKOWHALE_OFFLINE=1，跳过 digest 集成用例（涉及下载/同步）');
} else {
  console.log(`\n## digest 集成（插件：${installed}）`);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const logs = [];
  const nk = createNekowhaleStickers({
    pluginDir: installed,
    dataDir: DATA_DIR,
    profile: 'desktop',
    autoSync: 'lazy',
    log: (message, level) => logs.push(`${level ?? 'info'}: ${message}`)
  });
  try {
    {
      const out = await nk.digest('好耶[sticker:摸鱼]');
      ok(out.text === '好耶', '[sticker:名字] 从正文里摘掉');
      ok(out.stickers.length === 1 && out.stickers[0].source === 'ref', '标记解析成一张 ref 表情');
      const buf = await readStickerFile(out.stickers[0].path);
      ok(buf.subarray(0, 4).toString('latin1') === 'GIF8', '拿到的确实是 GIF 字节');
      ok(buf.length > 1024, 'GIF 不是空文件');
    }
    {
      const out = await nk.digest('这个 [sticker:绝对不存在的表情名] 别吞');
      ok(out.stickers.length === 0, '未知名字不产生表情');
      ok(out.text.includes('[sticker:绝对不存在的表情名]'), '未知名字原样还给模型');
    }
    {
      const kit = await nk.getKit();
      const all = await kit.all(false);
      const hash = all?.[0]?.hash;
      ok(Boolean(hash), '知识库里能拿到 hash（供下一条用例构造图片行）');
      if (hash) {
        const out = await nk.digest(`![摸鱼](http://127.0.0.1:60019/nekowhale/s/${hash}.gif)\n把上面这行原样放进回复即可显示。`);
        ok(out.text === '', '只有图片行 + 说明时正文为空');
        ok(out.stickers.length === 1 && out.stickers[0].source === 'hash', '图片行按 hash 解析成表情');
      }
    }
    {
      const out = await nk.digest('[sticker:摸鱼][sticker:摸鱼]再来一张');
      ok(out.stickers.length === 1, '同一条回复里重复的表情只发一次');
      ok(out.text === '再来一张', '重复标记不会在正文里留残渣');
    }
    {
      const out = await nk.digest(`[sticker:摸鱼]${'[sticker:开心]'.repeat(MAX_STICKERS_PER_REPLY + 2)}`);
      ok(out.stickers.length <= MAX_STICKERS_PER_REPLY, `一条回复最多 ${MAX_STICKERS_PER_REPLY} 张表情`);
    }
    {
      ok(fs.existsSync(DATA_DIR), '图片缓存写进了指定的 dataDir');
      ok(!fs.existsSync(path.join(process.cwd(), 'state', 'nekowhale', 'packs')), '没有偷偷写 state/nekowhale');
    }
  } catch (error) {
    fail += 1;
    console.error(`  ❌ digest 用例抛错：${error?.message ?? error}`);
    if (logs.length) console.error(logs.slice(-8).join('\n'));
  } finally {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
