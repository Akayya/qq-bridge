// 模拟 DSH 的 dsh-mcp-client：以 stdio 拉起桥接的 MCP server，握手并列出工具，
// 验证三个 MCP server 在新版 DSH 环境下仍能被正常接入（不需要 SnowLuma 在线）。
// 额外：真正 call 一次 qq_memory_query(category=global)，防止工具 handler 里再出现
// 「参数名被同名 const 遮住」这类只在运行时才炸的 TDZ 错误（历史 bug：Cannot access 'q' before initialization）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const CONSOLE = process.env.BRIDGE_CONSOLE_URL || 'http://127.0.0.1:3100';

const SERVERS = [
  { serverName: 'snowluma', script: 'src/mcp-snowluma-safe.js' },
  { serverName: 'snowluma-host', script: 'src/mcp-host-server.js' },
  { serverName: 'web-search-safe', script: 'src/mcp-web-search-safe.js' },
];

function sessionCandidates() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
    const conv = state?.conversations ?? {};
    const keys = Object.keys(conv).filter((k) => conv[k]?.agentToken);
    keys.sort((a, b) => Number(b.startsWith('private:')) - Number(a.startsWith('private:')));
    return keys.map((key) => ({ key, token: conv[key].agentToken }));
  } catch {
    return [];
  }
}

async function callMemoryQuery(client, session, extra) {
  const result = await client.callTool({
    name: 'qq_memory_query',
    arguments: { key: session.key, token: session.token, ...extra },
  });
  const text = (result?.content ?? []).map((c) => c?.text ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 200);
  return { text, isError: Boolean(result?.isError) };
}

async function probeMemoryQuery(client) {
  const sessions = sessionCandidates();
  if (!sessions.length) {
    console.log('   ⏭️  跳过共享记忆读取探针（state/social-v2.json 里没有可用会话令牌）');
    return;
  }
  let last = '';
  // 白名单内的会话才可能成功，逐个试（最多 6 个）
  for (const session of sessions.slice(0, 6)) {
    const base = await callMemoryQuery(client, session, { category: 'global' });
    if (/before initialization/i.test(base.text)) {
      console.log(`   ❌ qq_memory_query(category=global) → ${base.text}`);
      failures += 1;
      return;
    }
    if (base.isError || !/"ok":true/.test(base.text)) {
      last = `${session.key}: ${base.text}`;
      continue;
    }
    const withQ = await callMemoryQuery(client, session, { category: 'global', q: '鱼' });
    if (/before initialization/i.test(withQ.text) || withQ.isError || !/"ok":true/.test(withQ.text)) {
      console.log(`   ❌ qq_memory_query(category=global, q=鱼) → ${withQ.text}`);
      failures += 1;
      return;
    }
    const light = await callMemoryQuery(client, session, {});
    if (/before initialization/i.test(light.text) || light.isError) {
      console.log(`   ❌ qq_memory_query(轻量记忆) → ${light.text}`);
      failures += 1;
      return;
    }
    console.log(`   ✅ qq_memory_query(category=global) 正常（${session.key}，带/不带 q 都通过），轻量记忆分支也正常`);
    return;
  }
  console.log(`   ❌ qq_memory_query(category=global) 全部候选会话失败：${last}`);
  failures += 1;
}

async function bridgeUp() {
  try {
    // /api/status 需要控制台令牌；这里只关心「端口有没有人应答」，401 也算在线。
    await fetch(`${CONSOLE}/api/status`, { signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
const up = await bridgeUp();
if (!up) console.log(`ℹ️  桥接控制台 ${CONSOLE} 不可达：共享记忆探针会跳过（其余检查照常）`);

for (const { serverName, script } of SERVERS) {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [path.join(ROOT, script)],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'dsh-mcp-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`✅ ${serverName}: ${names.length} tools`);
    console.log(`   ${names.join(', ')}`);
    // 校验 DSH 的命名契约：mcp__<serverName>__<rawName>
    const bad = names.filter((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n));
    if (bad.length) { console.log(`   ⚠️ 不符合 DSH 工具名契约: ${bad.join(', ')}`); failures += 1; }
    if (serverName === 'snowluma') {
      if (!names.includes('qq_memory_query')) { console.log('   ❌ 缺少 qq_memory_query'); failures += 1; }
      else if (up) await probeMemoryQuery(client);
    }
  } catch (error) {
    console.log(`❌ ${serverName}: ${error?.message ?? error}`);
    failures += 1;
  } finally {
    try { await client.close(); } catch {}
  }
}
console.log(failures === 0 ? '\n全部 MCP server 接入正常' : `\n${failures} 个 MCP server 异常`);
process.exit(failures === 0 ? 0 : 1);