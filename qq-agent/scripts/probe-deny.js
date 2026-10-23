#!/usr/bin/env node
// 验证第二道防线：disallowedTools 是否真的能拒绝调用（不只是从列表里消失）。
// 用 WebFetch 做靶子 —— 它在 tools: [] 之后依然存在，是当前剩余风险里最现实的一个。
import { query } from '@tencent-ai/agent-sdk';
import { getApiKey, redact, ROOT } from '../src/secrets.js';
import fs from 'node:fs';
import path from 'node:path';

const SANDBOX = path.join(ROOT, 'data', 'sandbox');
fs.mkdirSync(SANDBOX, { recursive: true });

const { key, source } = getApiKey();
if (!key) {
  console.error('未配置 API Key');
  process.exit(1);
}
console.log(`凭据来源：${source}`);

const hits = [];
const q = query({
  prompt: '请用 WebFetch 工具抓取 https://example.com ，然后把页面标题告诉我。如果工具不可用，直说不可用。',
  options: {
    model: 'deepseek-v4.1-flash',
    effort: 'low',
    cwd: SANDBOX,
    permissionMode: 'default',
    maxTurns: 3,
    settingSources: [],
    tools: [],
    disallowedTools: ['WebFetch', 'WebSearch', 'Skill', 'SkillManage', 'Agent', 'Task'],
    canUseTool: async (toolName) => {
      hits.push(toolName);
      return { behavior: 'deny', message: `工具 ${toolName} 已禁用` };
    },
    env: {
      CODEBUDDY_API_KEY: key,
      CODEBUDDY_INTERNET_ENVIRONMENT: process.env.CODEBUDDY_INTERNET_ENVIRONMENT || 'internal'
    }
  }
});

let text = '';
let names = [];
for await (const m of q) {
  if (m.type === 'system' && Array.isArray(m.tools)) {
    if (!names.length) names = m.tools.map((t) => t?.name ?? t);
  }
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) if (b.type === 'text') text += b.text;
  }
}

console.log(`工具集仍包含 WebFetch：${names.includes('WebFetch')}`);
console.log(`canUseTool 被调用（说明 disallowedTools 没先拦住）：${hits.length ? hits.join(', ') : '否'}`);
console.log(`模型回复：${redact(text.trim().slice(0, 260))}`);
console.log(hits.length
  ? '\n结论：disallowedTools 未拦截，靠 canUseTool 兜住'
  : '\n结论：disallowedTools 生效（调用被前置拒绝）');
