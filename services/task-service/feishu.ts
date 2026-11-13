import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { TaskStore } from './store.ts';

type Config = { encryptKey: string; verificationToken: string; appId: string; tenants: string[]; senders: string[]; chats: string[] };

export function receiveFeishu(store: TaskStore, raw: string | Buffer, headers: { timestamp?: string; nonce?: string; signature?: string }, config: Config) {
  const envelope = JSON.parse(raw.toString());
  if (typeof envelope?.encrypt !== 'string') throw new Error('需要加密事件');
  const encrypted = Buffer.from(envelope.encrypt, 'base64');
  if (encrypted.length < 32 || encrypted.length % 16 !== 0) throw new Error('加密数据无效');
  const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(config.encryptKey).digest(), encrypted.subarray(0, 16));
  const data = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString('utf8'));
  const token = Buffer.from(typeof data.token === 'string' ? data.token : typeof data.header?.token === 'string' ? data.header.token : '');
  const expectedToken = Buffer.from(config.verificationToken);
  if (!expectedToken.length || token.length !== expectedToken.length || !timingSafeEqual(token, expectedToken)) throw new Error('验证令牌无效');
  if (data.type === 'url_verification' && typeof data.challenge === 'string') return { challenge: data.challenge };
  const expected = Buffer.from(createHash('sha256').update((headers.timestamp ?? '') + (headers.nonce ?? '') + config.encryptKey).update(raw).digest('hex'));
  const supplied = Buffer.from(headers.signature ?? '');
  const verified = !!headers.timestamp && !!headers.nonce && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  const sender = data.event?.sender?.sender_id?.open_id;
  const message = data.event?.message;
  let text: unknown;
  try { text = JSON.parse(message?.content).text; } catch { throw new Error('消息格式无效'); }
  if (data.header?.event_type !== 'im.message.receive_v1' || data.event?.sender?.sender_type !== 'user' || message?.message_type !== 'text' || typeof data.header?.event_id !== 'string' || typeof sender !== 'string' || typeof text !== 'string') throw new Error('不支持或无效的飞书事件');
  const scopeAllowed = data.header.app_id === config.appId && config.tenants.includes(data.header.tenant_key) && config.chats.includes(message.chat_id);
  const context = typeof message.message_id === 'string' && /^om_[a-zA-Z0-9]+$/.test(message.message_id) ? { messageId: message.message_id, tenant: data.header.tenant_key, chat: message.chat_id } : undefined;
  return store.ingestEvent({ source: 'feishu', id: data.header.event_id, sender, text, context }, verified && scopeAllowed, config.senders);
}
