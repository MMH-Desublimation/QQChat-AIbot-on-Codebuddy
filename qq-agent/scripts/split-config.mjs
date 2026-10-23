#!/usr/bin/env node
// 把 config.json 拆成「可公开的模板」+「本机私有的 config.local.json」。
//
// 开源前的必要一步：群号、QQ 号、唤醒关键词都属于个人信息，不能进公开仓库。
// 跑完之后：
//   · config/config.json       = 模板（占位值），会提交
//   · config/config.local.json = 真实值，被 .gitignore 排除
//
// 用法：node scripts/split-config.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'config', 'config.json');
const LOCAL = path.join(ROOT, 'config', 'config.local.json');

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
} catch (error) {
  console.error(`读不到模板配置：${error.message}`);
  process.exit(1);
}

if (fs.existsSync(LOCAL)) {
  console.log('config.local.json 已存在，先备份为 .bak');
  fs.copyFileSync(LOCAL, `${LOCAL}.bak`);
}

// 1) 真实值整份落到 local
fs.writeFileSync(LOCAL, JSON.stringify(cfg, null, 2), 'utf8');

// 2) 模板里抹掉个人信息
const tpl = JSON.parse(JSON.stringify(cfg));
tpl.onebot.selfQQ = 0;
tpl.onebot.accessToken = '';
tpl.identity.ownerQQ = 0;
tpl.identity.nickname = '小鲸鱼';
tpl.allow.groups = [];
tpl.allow.private = [];
tpl.allow.denyUsers = [];
tpl.allow.mustReplyKeywords = [];
tpl.persona.wake.keywords = [];
tpl.ui.consoleToken = '';
fs.writeFileSync(TEMPLATE, JSON.stringify(tpl, null, 2), 'utf8');

console.log('已拆分：');
console.log(`  模板（可提交）：${TEMPLATE}`);
console.log(`  私有（已忽略）：${LOCAL}`);
console.log(`  真实群号 ${cfg.allow.groups.length} 个、私聊 ${cfg.allow.private.length} 个、ownerQQ ${cfg.identity.ownerQQ || '未设'}`);
