#!/usr/bin/env node
// 验证执行端封装：systemPrompt 覆盖、三道防线参数、用量记账。
import { loadConfig } from '../src/config.js';
import { runTurn, usageToday, budgetExhausted } from '../src/agent/runner.js';

const cfg = loadConfig({ reload: true });
console.log(`模式=${cfg.mode} 模型=${cfg.model.name} 强度=${cfg.model.effort} maxTurns=${cfg.limits.maxTurnsPerRound}`);

const before = usageToday();
console.log(`今日累计（前）：${before.tokens} token / ${before.rounds} 轮`);

const res = await runTurn({
  cfg,
  system: '你是一个只会说两个字「可以」的测试机器人。不管对方说什么，都只回「可以」这两个字，不要解释。',
  user: '你好，请介绍一下你自己'
});

console.log('\n──────── 结果 ────────');
console.log(`ok=${res.ok} reason=${res.reason ?? '-'} tokens=${res.tokens}`);
console.log(`回复：${res.text.trim().slice(0, 120)}`);

const after = usageToday();
console.log(`今日累计（后）：${after.tokens} token / ${after.rounds} 轮`);
console.log(`预算是否耗尽：${budgetExhausted(cfg)}`);
