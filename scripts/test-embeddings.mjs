// 向量检索（语义召回）自测：
//   node scripts/test-embeddings.mjs          全量
//   node scripts/test-embeddings.mjs --unit   只跑纯计算部分（不加载模型）
//
// 覆盖：
//   1. cosine 基本性质
//   2. 嵌入器加载 + 维度
//   3. 写入后异步补算向量 / 历史回填
//   4. 语义召回命中同义改写、不误伤无关句
//   5. minScore 门槛与 scope 过滤
//   6. injectBundle 把「字重合」与「语义」结果合并
//   7. 没挂嵌入器时整层降级（不报错、返回空）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSharedMemory } from '../src/shared-memory.js';
import { createEmbedder, cosine } from '../src/embeddings.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    fail += 1;
    failures.push(`${name}: ${error?.message ?? error}`);
    console.log(`  ❌ ${name} -> ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    fail += 1;
    failures.push(`${name}: ${error?.message ?? error}`);
    console.log(`  ❌ ${name} -> ${error?.message ?? error}`);
  }
}

const unitOnly = process.argv.includes('--unit');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-test-'));
const OWNER = 10001;
const OWNER_KEY = `private:${OWNER}`;
const logs = [];
const log = (m) => logs.push(String(m));

function makeMemory(name, embedder = null) {
  const mem = createSharedMemory({
    dbPath: path.join(tmpDir, `${name}.db`),
    ownerQQ: OWNER,
    log,
    sanitize: (t) => String(t),
    isSensitive: () => false
  });
  if (embedder) {
    mem.setEmbedder(embedder);
  }
  return mem;
}

console.log('向量检索自测');
console.log('─ 纯计算 ─');
check('cosine(同一向量) = 1', () => {
  const a = Float32Array.from([1, 0, 0]);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6);
});
check('cosine(正交) = 0', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.equal(cosine(a, b), 0);
});
check('cosine(长度不等) = 0', () => {
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])), 0);
});

console.log('─ 降级 ─');
const plain = makeMemory('plain');
check('没有嵌入器时语义召回返回空（不抛错）', () => {
  plain.append({ kind: 'fact', text: '主人养了只猫叫年糕', sourceKey: OWNER_KEY, scope: 'owner' });
  assert.deepEqual(plain.semanticFor(OWNER_KEY, Float32Array.from([1, 2, 3])), []);
});
check('没有嵌入器时 injectBundle 仍可用（走字重合）', () => {
  const r = plain.injectBundle(OWNER_KEY, { recentText: '你家那只猫最近还好吗' });
  assert.equal(r.semanticIds.length, 0);
  assert.ok(r.text.includes('年糕') || r.relatedText.includes('年糕'));
});
plain.close();

if (!unitOnly) {
  console.log('─ 模型与语义 ─');
  const embedder = createEmbedder({
    model: 'Xenova/bge-small-zh-v1.5',
    dtype: 'q8',
    cacheDir: path.join(tmpDir, 'models'),
    log
  });

  await checkAsync('模型加载成功', async () => {
    const ok = await embedder.warm();
    assert.equal(ok, true, `加载失败：${embedder.info().error}`);
    assert.equal(embedder.info().status, 'ready');
  });

  await checkAsync('向量维度为 512', async () => {
    const vs = await embedder.embed(['测试句子']);
    assert.equal(vs.length, 1);
    assert.equal(vs[0].length, 512);
  });

  await checkAsync('同义句相似度 > 无关句', async () => {
    const [a, b, c] = await embedder.embed([
      '管理员喝咖啡只喝冰美式，热的完全不行',
      '今天早上又点了杯冰咖啡',
      '股票今天跌了三个点'
    ]);
    const near = cosine(a, b);
    const far = cosine(a, c);
    assert.ok(near > far + 0.08, `同义 ${near.toFixed(3)} vs 无关 ${far.toFixed(3)}`);
  });

  const mem = makeMemory('semantic', embedder);
  await checkAsync('写入后异步补算向量', async () => {
    mem.append({ kind: 'preference', text: '管理员喝咖啡只喝冰美式，热的完全不行', sourceKey: OWNER_KEY, scope: 'owner' });
    mem.append({ kind: 'fact', text: '主人养了只猫叫年糕', sourceKey: OWNER_KEY, scope: 'owner' });
    mem.append({ kind: 'fact', text: '群友小张在杭州做前端', sourceKey: 'group:90001', scope: 'key:group:90001' });
    await mem.flushEmbed();
    const st = mem.stats();
    assert.equal(st.embedded, 3, `embedded=${st.embedded}`);
  });

  await checkAsync('语义召回命中同义改写', async () => {
    const [qv] = await embedder.embed(['今天早上又点了杯冰咖啡，热的真受不了']);
    const hits = mem.semanticFor(OWNER_KEY, qv, { limit: 3, minScore: 0.4 });
    assert.ok(hits.length >= 1, '没有召回任何条目');
    assert.ok(hits[0].text.includes('冰美式'), `首条不是咖啡记忆：${hits[0]?.text}`);
  });

  await checkAsync('无关句不命中（minScore 0.5）', async () => {
    const [qv] = await embedder.embed(['股票今天跌了三个点']);
    const hits = mem.semanticFor(OWNER_KEY, qv, { limit: 3, minScore: 0.5 });
    assert.equal(hits.length, 0, `误召回了 ${hits.map((h) => h.text).join(' / ')}`);
  });

  await checkAsync('scope 过滤：群里的私有记忆不串到私聊', async () => {
    const [qv] = await embedder.embed(['群友小张在杭州做前端']);
    const hits = mem.semanticFor(OWNER_KEY, qv, { limit: 5, minScore: 0.3 });
    assert.ok(!hits.some((h) => h.text.includes('小张')), '私聊看到了别的群的私有记忆');
  });

  await checkAsync('injectBundle 合并字重合与语义结果', async () => {
    // 单独一套库：LRU 只会带最新那条（报告），咖啡记忆必须靠语义层补进来
    const merge = makeMemory('merge', embedder);
    merge.append({ kind: 'preference', text: '管理员喝咖啡只喝冰美式，热的完全不行', sourceKey: OWNER_KEY, scope: 'owner' });
    merge.append({ kind: 'fact', text: '猫叫年糕', sourceKey: OWNER_KEY, scope: 'owner' });
    merge.append({ kind: 'fact', text: '周五要交季度报告', sourceKey: OWNER_KEY, scope: 'owner' });
    await merge.flushEmbed();
    const [qv] = await embedder.embed(['今天点了杯冰咖啡']);
    const r = merge.injectBundle(OWNER_KEY, {
      recentText: '随便聊聊',
      queryVec: qv,
      minScore: 0.4,
      maxEntries: 1
    });
    const merged = `${r.text}\n${r.relatedText}`;
    assert.ok(merged.includes('冰美式'), `语义召回的咖啡记忆没进注入文本：${merged}`);
    assert.ok(r.semanticIds.length >= 1, 'semanticIds 为空，说明没走语义层');
    assert.ok(!r.injectedIds.includes(r.semanticIds[0]), '同一条被 LRU 与语义重复注入');
    merge.close();
  });

  await checkAsync('历史回填：手工清空向量后能补回来', async () => {
    const id = mem.listAll().find((e) => e.text.includes('年糕'))?.id;
    const raw = new DatabaseSync(path.join(tmpDir, 'semantic.db'));
    raw.prepare('UPDATE memories SET embedding = NULL WHERE id = ?').run(id);
    raw.close();
    const filled = await mem.backfill({ limit: 10 });
    assert.ok(filled >= 1, `回填了 ${filled} 条`);
    assert.equal(mem.stats().embedded, 3);
  });

  await checkAsync('模型信息可读', async () => {
    const info = mem.stats().embed;
    assert.equal(info.status, 'ready');
    assert.equal(info.dim, 512);
    assert.ok(info.items >= 6, `items=${info.items}`);
  });

  mem.close();
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log(failures.join('\n'));
  process.exit(1);
}