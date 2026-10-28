// 从 SnowLuma 的 QQ 历史里重建某个私聊的 recentMessages（会话重置会把它清空）
import fs from 'node:fs';

const KEY = process.argv[2] || 'private:2086366020';
const COUNT = Number(process.argv[3] || 60);
const PEER = Number(KEY.split(':')[1]);
const BOT = 2826691494;

const cfg = JSON.parse(fs.readFileSync('D:/DSH_QQ_BOT/config.json', 'utf8'));
const token = cfg.snowluma?.accessToken || '';
const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');

const res = await fetch(`${base}/get_friend_msg_history`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ user_id: PEER, count: COUNT })
});
const body = await res.json();
if (body?.status !== 'ok') {
  console.error('拉取历史失败：', JSON.stringify(body).slice(0, 300));
  process.exit(1);
}
const raw = body.data?.messages ?? [];

function flatten(segments) {
  const parts = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    if (type === 'text') parts.push(String(data.text ?? ''));
    else if (type === 'image') parts.push(data.sub_type === 1 ? '[动画表情]' : '[图片]');
    else if (type === 'face' || type === 'mface') parts.push('[表情]');
    else if (type === 'record') parts.push('[语音]');
    else if (type === 'video') parts.push('[视频]');
    else if (type === 'file') parts.push('[文件]');
    else if (type === 'at') parts.push(`@${data.qq ?? ''}`);
    else if (type === 'forward') parts.push('[转发消息]');
  }
  return parts.join('').trim();
}

const messages = raw.map((m) => {
  const isSelf = Number(m.user_id) === BOT;
  const text = flatten(m.message) || '[消息]';
  return {
    seq: Number(m.message_seq) || undefined,
    messageId: String(m.real_id ?? m.message_id ?? ''),
    sender: isSelf ? '我' : '私聊',
    userId: String(m.user_id),
    text,
    plain: text,
    tail: text,
    quoteTargetIsSelf: false,
    isOwner: isSelf,
    ownerLabel: isSelf ? '我' : '',
    isSelf,
    media: [],
    hasMedia: false,
    forwardIds: [],
    hasForward: false,
    time: Number(m.time) * 1000 || Date.now()
  };
});

const file = 'D:/DSH_QQ_BOT/state/social-v2.json';
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const st = doc.conversations?.[KEY];
if (!st) {
  console.error('会话不存在：', KEY);
  process.exit(1);
}
fs.copyFileSync(file, `${file}.bak-restore`);
st.recentMessages = messages.slice(-100);
const incoming = messages.filter((m) => !m.isSelf);
if (incoming.length) st.lastIncomingAt = incoming.at(-1).time;
st.unread = [];
fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
console.log(`已写回 ${st.recentMessages.length} 条（其中自己 ${messages.length - incoming.length} 条，最后来信 ${incoming.length ? new Date(st.lastIncomingAt).toLocaleTimeString() : '无'}）`);