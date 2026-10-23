#!/usr/bin/env node
// 验证「唯一可用工具 = 简易搜索」这条边界：
//   1. 工具表里只能出现 mcp__qq__web_search（没有 Bash/Write/WebFetch）
//   2. 模型真的能搜到东西
//   3. 让它做复杂任务时会被推掉
import { query } from '@tencent-ai/agent-sdk';
import { loadConfig } from '../src/config.js';
import { getApiKey, redact, ROOT } from '../src/secrets.js';
import { MCP_SERVER_NAME, qqToolServer } from '../src/agent/tools.js';
import { DISALLOWED_TOOLS, LOCKED_MODEL } from '../src/agent/runner.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = loadConfig({ reload: true });
const sandbox = path.join(ROOT, 'data', 'sandbox');
fs.mkdirSync(sandbox, { recursive: true });

const { key } = getApiKey();
if (!key) {
  console.error('未配置 API Key');
  process.exit(1);
}

const prompt = process.argv[2] || '今天北京天气怎么样？用你的搜索工具查一下，一句话回答。';

const q = query({
  prompt,
  options: {
    model: LOCKED_MODEL,
    effort: cfg.model?.effort || 'high',
    cwd: sandbox,
    permissionMode: 'default',
    maxTurns: 4,
    settingSources: [],
    tools: [],
    disallowedTools: DISALLOWED_TOOLS,
    mcpServers: { [MCP_SERVER_NAME]: qqToolServer },
    canUseTool: async (name, input) =>
      (String(name).startsWith(`mcp__${MCP_SERVER_NAME}__`)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `工具 ${name} 不可用`, interrupt: true }),
    env: {
      CODEBUDDY_API_KEY: key,
      CODEBUDDY_INTERNET_ENVIRONMENT: process.env.CODEBUDDY_INTERNET_ENVIRONMENT || 'internal'
    }
  }
});

let text = '';
let tools = [];
const calls = [];
for await (const m of q) {
  if (m.type === 'system' && Array.isArray(m.tools) && !tools.length) {
    tools = m.tools.map((t) => t?.name ?? t);
  }
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'text') text += b.text;
      if (b.type === 'tool_use') {
        calls.push(b.name);
        console.log(`→ ${b.name}  ${JSON.stringify(b.input ?? {}).slice(0, 120)}`);
      }
    }
  }
}

console.log('\n工具表（应只有搜索 + 少量无害项）：');
console.log('  ' + (tools.filter((t) => !t.startsWith('mcp__')).join(', ') || '(无内置)'));
console.log('  自建：' + (tools.filter((t) => t.startsWith('mcp__')).join(', ') || '(无)'));

const hasDanger = tools.some((t) => /^(Bash|PowerShell|Read|Write|Edit|WebFetch|WebSearch|Task|Agent|Skill)/.test(t));
console.log(`危险工具：${hasDanger ? '❌ 仍存在' : '✅ 无'}`);
console.log(`工具调用：${calls.join(', ') || '（无）'}`);
console.log(`回复：${redact(text.trim().slice(0, 300))}`);
