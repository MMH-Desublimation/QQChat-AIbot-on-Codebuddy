#!/usr/bin/env node
// 入口：按配置里的 mode 启动对应引擎。
//
// 启动前置：NapCat 已经在跑并登录了机器人号（WS 3001 / HTTP 3000）。
// 本进程只做"事件 → 模型 → 发送"，不碰任何本地文件命令。
import { loadConfig, publicConfig } from './config.js';
import { OneBotClient } from './onebot/client.js';
import { createChatMode } from './modes/chat.js';
import { createPersonaMode } from './modes/persona.js';
import { apiKeyStatus } from './secrets.js';
import { usageToday, budgetExhausted } from './agent/runner.js';
import { createLogger } from './logger.js';
import { startControlServer } from './control.js';

const log = createLogger('main');

async function main() {
  const cfg = loadConfig({ reload: true });
  const safe = publicConfig();

  log.info(`模式=${cfg.mode} 模型=${cfg.model.name} 强度=${cfg.model.effort}`);
  log.info(`群白名单：${safe.allow.groups.join(', ') || '（空，不会响应任何群）'}`);
  log.info(`私聊白名单：${safe.allow.private.join(', ') || '（空）'} 主人：${cfg.identity.ownerQQ || '未设置'}`);

  const keyStatus = apiKeyStatus();
  if (!keyStatus.configured) {
    log.error('未配置 CodeBuddy API Key。请在图形界面「设置」里填写，或设置环境变量 CODEBUDDY_API_KEY。');
    process.exit(1);
  }
  log.info(`凭据：${keyStatus.source}（${keyStatus.masked}）`);

  const usage = usageToday();
  log.info(`今日已用 ${usage.tokens} token / ${usage.rounds} 轮；日预算 ${cfg.limits.dailyTokenBudget || '不限'}`);
  if (budgetExhausted(cfg)) log.warn('今日预算已耗尽，本进程只会做只读动作');

  if (safe.allow.groups.length === 0 && safe.allow.private.length === 0) {
    log.warn('白名单为空：按 fail-closed 设计，不会响应任何消息。请在界面里添加群或私聊。');
  }

  // 先把 client 建出来（它的回调里用一个可变引用指向引擎），再按模式挑引擎。
  let engine = null;
  const client = new OneBotClient(cfg, {
    onMessage: (payload) => {
      engine?.handleMessage(payload);
    },
    onNotice: (payload) => {
      if (payload.notice_type === 'notify' && payload.sub_type === 'poke') {
        log.info(`收到拍一拍：${payload.user_id} -> ${payload.target_id}`);
        engine?.handlePoke?.(payload);
      }
    },
    onLifecycle: () => {}
  });

  // 两个引擎都建好，只启用一个。切换模式需要重启进程（GUI 保存后会提示）。
  const chatMode = createChatMode({ cfg, client });
  const personaMode = createPersonaMode({ cfg, client });
  engine = cfg.mode === 'persona' ? personaMode : chatMode;
  log.info(`引擎：${cfg.mode === 'persona' ? '拟真（潜水+唤醒，命中才花 token）' : 'chat（收到即回）'}`);

  // 界面要能看/清各会话上下文，所以开一个只给本机用的控制口
  startControlServer({ port: 3101, engine });

  // 每 60 秒吐一次用量，方便观察消耗。
  // 不 unref：它同时充当"进程保活"的把手，否则 WS 断开期间进程会自己退出。
  setInterval(() => {
    const u = usageToday();
    log.info(`用量快照：今日 ${u.tokens} token / ${u.rounds} 轮`);
  }, 60000);

  await client.connect();

  const shutdown = (sig) => {
    log.info(`收到 ${sig}，退出`);
    try { client.close(); } catch { /* 忽略 */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  log.error(`启动失败：${error?.message ?? error}`);
  process.exit(1);
});
