#!/usr/bin/env node
// SDK 接通验证：确认 API Key 可用、模型是 deepseek-v4.1-flash、思考强度 high 生效、
// 以及"工作目录隔离 + 不加载任何文件配置"这两条安全前提真的成立。
//
// 用法：npm run probe:sdk
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@tencent-ai/agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 读 .env（不依赖外部工具）
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.CODEBUDDY_API_KEY) {
  console.error('缺少 CODEBUDDY_API_KEY（.env）');
  process.exit(1);
}

// 沙箱目录：Agent 的 cwd 指向这里，绝不指向真实工作区
const SANDBOX = path.join(ROOT, 'data', 'sandbox');
fs.mkdirSync(SANDBOX, { recursive: true });

const MODEL = process.env.PROBE_MODEL || 'deepseek-v4.1-flash';
const EFFORT = process.env.PROBE_EFFORT || 'high';

console.log(`模型=${MODEL} 强度=${EFFORT} cwd=${SANDBOX}\n`);

const started = Date.now();
let text = '';
let tools = [];
let resultInfo = null;

try {
  const q = query({
    prompt: '只回复两个字：可以',
    options: {
      model: MODEL,
      effort: EFFORT,
      cwd: SANDBOX,
      permissionMode: 'default',
      maxTurns: 2,
      // 关键安全前提：不加载 settings / CODEBUDDY.md / MCP / agents / skills
      settingSources: [],
      env: {
        CODEBUDDY_API_KEY: process.env.CODEBUDDY_API_KEY,
        CODEBUDDY_INTERNET_ENVIRONMENT: process.env.CODEBUDDY_INTERNET_ENVIRONMENT || 'internal'
      }
    }
  });

  for await (const message of q) {
    if (message.type === 'system') {
      tools = (message.tools ?? []).map((t) => t?.name ?? t);
      console.log(`init: session=${message.session_id} 工具数=${tools.length}`);
      if (message.model) console.log(`init: model=${message.model}`);
      if (tools.length) console.log(`  工具：${tools.slice(0, 10).join(', ')}${tools.length > 10 ? ' …' : ''}`);
    }
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') text += block.text;
      }
    }
    if (message.type === 'result') {
      resultInfo = message;
    }
  }
} catch (error) {
  console.error(`失败：${error?.message ?? error}`);
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

console.log('\n──────── 结果 ────────');
console.log(`回复：${text.trim() || '（空）'}`);
if (resultInfo) {
  console.log(`subtype=${resultInfo.subtype} 耗时=${resultInfo.duration_ms ?? '?'}ms 估算成本=${resultInfo.total_cost_usd ?? '?'}`);
  const u = resultInfo.usage;
  if (u) console.log(`用量：input=${u.input_tokens} output=${u.output_tokens} cache_read=${u.cache_read_input_tokens ?? 0}`);
}
console.log(`墙钟：${Date.now() - started}ms`);
console.log(`\n沙箱目录内容（应为空）：${JSON.stringify(fs.readdirSync(SANDBOX))}`);
