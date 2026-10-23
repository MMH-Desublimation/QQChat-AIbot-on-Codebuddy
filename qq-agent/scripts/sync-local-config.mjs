#!/usr/bin/env node
// 把模板 config.json 里的**行为配置**同步到 config.local.json。
//
// 背景：GUI 保存写的是 local；但如果界面进程还在跑旧代码（写模板），
// 就会出现"模板新、local 旧"的冲突 —— local 优先级更高，界面上改的设置看不到效果。
// 这个脚本用于把模板里的行为配置补齐到 local，同时**不动**隐私字段（群号/QQ/关键词）。
//
// 用法：node scripts/sync-local-config.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8'));
const write = (f, v) => fs.writeFileSync(path.join(ROOT, 'config', f), JSON.stringify(v, null, 2), 'utf8');

const tpl = read('config.json');
let local;
try {
  local = read('config.local.json');
} catch {
  console.error('没有 config.local.json，请先运行 node scripts/split-config.mjs');
  process.exit(1);
}

local.mode = tpl.mode;
local.model = { ...local.model, ...tpl.model };
local.limits = { ...local.limits, ...tpl.limits };
local.send = { ...local.send, ...tpl.send };
local.search = { ...local.search, ...tpl.search };
local.injection = { ...local.injection, ...tpl.injection };
local.ui = { ...local.ui, ...tpl.ui, consoleToken: local.ui?.consoleToken ?? '' };

// wake 只同步"行为参数"，keywords 属隐私，保留 local 的
const w = tpl.persona.wake;
local.persona = local.persona ?? {};
local.persona.wake = {
  ...(local.persona.wake ?? {}),
  wakePerMinute: w.wakePerMinute,
  wakePerHour: w.wakePerHour,
  probability: w.probability,
  atMention: w.atMention,
  nameMention: w.nameMention,
  question: w.question,
  poke: w.poke,
  batchWindowMs: w.batchWindowMs,
  replyCheckMs: w.replyCheckMs
};
local.persona.context = { ...(local.persona.context ?? {}), ...(tpl.persona.context ?? {}) };

write('config.local.json', local);
console.log('已同步到 config.local.json：');
console.log(`  mode=${local.mode}  wakePerMinute=${local.persona.wake.wakePerMinute}  wakePerHour=${local.persona.wake.wakePerHour}`);
console.log(`  群号/私聊/关键词保持原样：groups=${local.allow.groups.length} private=${local.allow.private.length} keywords=${local.persona.wake.keywords.length}`);
