// 拟真模式的判定逻辑（纯函数，不联网不花钱）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionedBy, looksLikeQuestion } from '../src/modes/persona.js';

const cfg = {
  identity: { nickname: '小鲸鱼' },
  persona: { wake: { keywords: ['DeepSeek', '大肥鱼'] } }
};

test('mentionedBy 命中昵称/关键词，大小写不敏感', () => {
  assert.equal(mentionedBy('小鲸鱼在吗', cfg), true);
  assert.equal(mentionedBy('今天 deepseek 好用吗', cfg), true);
  assert.equal(mentionedBy('大肥鱼出来', cfg), true);
  assert.equal(mentionedBy('今天天气不错', cfg), false);
});

test('mentionedBy 忽略空关键词', () => {
  const c = { identity: {}, persona: { wake: { keywords: ['', null, '   '] } } };
  assert.equal(mentionedBy('随便聊聊', c), false);
});

test('looksLikeQuestion 识别常见问句', () => {
  assert.equal(looksLikeQuestion('这是什么？'), true);
  assert.equal(looksLikeQuestion('你在吗'), true);
  assert.equal(looksLikeQuestion('怎么弄'), true);
  assert.equal(looksLikeQuestion('有没有人'), true);
  assert.equal(looksLikeQuestion('今天好累'), false);
});
