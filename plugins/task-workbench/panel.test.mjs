import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function setup(request) {
  class Element {
    constructor() { this.value = ''; this.textContent = ''; this.className = ''; this.children = []; this.events = {}; }
    addEventListener(type, handler) { this.events[type] = handler; }
    replaceChildren(...children) { this.children = children; }
    append(child) { this.children.push(child); }
  }
  const elements = new Map();
  const document = {
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); },
    createElement() { return new Element(); }
  };
  const html = readFileSync(new URL('./panel.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, { document, window: { orca: { plugin: { request } } } });
  return document;
}

test('任务保存结果不确定时提示核对，保存后刷新失败不虚报保存失败', async () => {
  let createSucceeds = false;
  let failRefresh = false;
  const document = setup(async name => {
    if (name === 'tasks.list') { if (failRefresh) throw new Error('断开'); return []; }
    if (name === 'workspaces.list') return { workspaces: [], truncated: false };
    if (name === 'executions.list') return [];
    if (name === 'tasks.create') { if (!createSucceeds) throw new Error('超时'); failRefresh = true; return {}; }
    throw new Error(`unexpected: ${name}`);
  });
  await new Promise(resolve => setImmediate(resolve));
  const input = document.querySelector('#task');
  const form = document.querySelector('#task-form');
  const button = { disabled: false };
  input.value = '待保存';
  await form.events.submit({ preventDefault() {}, submitter: button });
  assert.match(document.querySelector('#message').textContent, /无法确认保存结果/);
  assert.equal(input.value, '待保存');
  assert.equal(button.disabled, false);
  createSucceeds = true;
  await form.events.submit({ preventDefault() {}, submitter: button });
  assert.match(document.querySelector('#message').textContent, /任务已保存，但列表刷新失败/);
  assert.equal(input.value, '');
  assert.equal(button.disabled, false);
});

test('读取另一执行的日志失败时不会继续显示上一执行的日志', async () => {
  const document = setup(async (name, input) => {
    if (name === 'tasks.list') return [];
    if (name === 'workspaces.list') return { workspaces: [], truncated: false };
    if (name === 'executions.list') return [
      { id: 'first', taskId: 'task1', state: 'unknown', orcaId: 'term1' },
      { id: 'second', taskId: 'task2', state: 'unknown', orcaId: 'term2' }
    ];
    if (name === 'executions.read') { if (input.id === 'second') throw new Error('断开'); return { lines: ['第一条日志'], truncated: false }; }
    throw new Error(`unexpected: ${name}`);
  });
  await new Promise(resolve => setImmediate(resolve));
  const entries = document.querySelector('#executions').children;
  await entries[0].children[1].events.click();
  assert.match(document.querySelector('#logs').textContent, /第一条日志/);
  await entries[1].children[1].events.click();
  assert.match(document.querySelector('#logs').textContent, /second.*日志不可用/);
  assert.doesNotMatch(document.querySelector('#logs').textContent, /第一条日志/);
});
