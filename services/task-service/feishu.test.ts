import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from './store.ts';
import { receiveFeishu } from './feishu.ts';

test('飞书加密事件、签名、授权和重启去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-intake-'));
  const config = { encryptKey: 'encrypt-key', verificationToken: 'token', appId: 'app', tenants: ['tenant'], senders: ['sender'], chats: ['chat'] };
  const encrypt = (data: unknown) => {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(config.encryptKey).digest(), iv);
    return JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64') });
  };
  try {
    const path = join(dir, 'tasks.db');
    let store = new TaskStore(path);
    assert.deepEqual(receiveFeishu(store, encrypt({ type: 'url_verification', token: 'token', challenge: 'abc' }), {}, config), { challenge: 'abc' });
    const raw = encrypt({ header: { token: 'token', app_id: 'app', tenant_key: 'tenant', event_id: 'evt', event_type: 'im.message.receive_v1' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'sender' } }, message: { chat_id: 'chat', message_id: 'om_abc123', message_type: 'text', content: JSON.stringify({ text: '任务' }) } } });
    const headers = { timestamp: '123', nonce: 'nonce', signature: createHash('sha256').update('123nonce' + config.encryptKey + raw).digest('hex') };
    assert.equal(receiveFeishu(store, raw, { ...headers, signature: 'wrong' }, config).outcome, 'invalid');
    assert.equal(receiveFeishu(store, raw, headers, { ...config, senders: [] }).outcome, 'unauthorized');
    assert.equal(receiveFeishu(store, raw, headers, { ...config, chats: [] }).outcome, 'invalid');
    assert.equal(receiveFeishu(store, raw, headers, config).outcome, 'accepted');
    store.close(); store = new TaskStore(path);
    assert.equal(receiveFeishu(store, raw, headers, config).outcome, 'duplicate');
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.sourceContext(store.list()[0].id as string), { source: 'feishu', context: { messageId: 'om_abc123', tenant: 'tenant', chat: 'chat' } });
    assert.equal(store.list()[0].status, 'pending');
    assert.throws(() => receiveFeishu(store, raw, headers, { ...config, verificationToken: 'wrong' }));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
