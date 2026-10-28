// 起一个真实的 MCP server 子进程，走 stdio 握手后 tools/list，确认 qq_ocr 真的注册了。
import { spawn } from 'node:child_process';
import path from 'node:path';

const nodeExe = process.execPath;
const server = path.join(process.cwd(), 'src', 'mcp-snowluma-safe.js');
const child = spawn(nodeExe, [server], { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() });

let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write('[server] ' + c.toString('utf8')));

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => reject(new Error('超时: ' + method)), 20000);
  });
}

try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'qq-bridge-tool-check', version: '1.0.0' },
  });
  console.log('initialize:', init.result?.serverInfo?.name || '(未知)');
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const list = await request(2, 'tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  console.log('工具数:', names.length);
  const hit = names.find((n) => n === 'qq_ocr');
  console.log('qq_ocr 注册:', hit ? 'YES' : 'NO');
  console.log('全部工具:', names.join(', '));
  const tool = (list.result?.tools || []).find((t) => t.name === 'qq_ocr');
  if (tool) console.log('qq_ocr 描述前 80 字:', tool.description.slice(0, 80));
} finally {
  child.kill();
}
