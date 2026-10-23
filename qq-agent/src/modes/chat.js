// chat 模式：收到消息即回复。群聊与私聊走同一套队列/限流/审计。
//
// 每会话一条串行队列 + 两道限流（每分钟/每小时）+ 出站审计，保证：
//   · 不会因为刷屏而并发拉起多个模型调用
//   · 不会在 1 分钟内被刷出几十块钱
import { isGroupAllowed, isPrivateAllowed } from '../config.js';
import { segmentsToText } from '../onebot/client.js';
import { cleanIncoming, wrapAsData, hitsKeyword } from '../safety/guard.js';
import { buildSystemPrompt, buildRecentLines } from '../agent/persona.js';
import { runTurn, budgetExhausted } from '../agent/runner.js';
import { sendToGroup, sendToPrivate } from '../onebot/sender.js';
import { createLogger } from '../logger.js';

const log = createLogger('chat');
const SILENT = '[SILENT]';

export function createChatMode({ cfg, client }) {
  /** key -> Promise（每会话串行） */
  const queues = new Map();
  /** key -> { minute:number[], hour:number[] } */
  const counters = new Map();
  /** key -> [{sender,text,isSelf,time}] */
  const recent = new Map();
  /** key -> { failures:number, pausedUntil:number } */
  const breakers = new Map();

  const nowMs = () => Date.now();

  function allowRound(key) {
    const c = counters.get(key) ?? { minute: [], hour: [] };
    const now = nowMs();
    c.minute = c.minute.filter((t) => now - t < 60000);
    c.hour = c.hour.filter((t) => now - t < 3600000);
    const maxMin = Number(cfg.limits?.roundsPerMinutePerGroup) || 6;
    const maxHour = Number(cfg.limits?.roundsPerHourPerGroup) || 60;
    if (c.minute.length >= maxMin) {
      counters.set(key, c);
      return { ok: false, reason: `每分钟上限 ${maxMin}` };
    }
    if (c.hour.length >= maxHour) {
      counters.set(key, c);
      return { ok: false, reason: `每小时上限 ${maxHour}` };
    }
    c.minute.push(now);
    c.hour.push(now);
    counters.set(key, c);
    return { ok: true };
  }

  function breakerBlocked(key) {
    const b = breakers.get(key);
    if (!b) return false;
    if (b.pausedUntil > nowMs()) return true;
    b.pausedUntil = 0;
    b.failures = 0;
    return false;
  }

  function noteFailure(key) {
    const b = breakers.get(key) ?? { failures: 0, pausedUntil: 0 };
    b.failures += 1;
    const limit = Number(cfg.limits?.breaker?.failures) || 3;
    if (b.failures >= limit) {
      b.pausedUntil = nowMs() + (Number(cfg.limits?.breaker?.pauseMs) || 600000);
      b.failures = 0;
      log.warn(`${key} 连续失败 ${limit} 次，暂停 ${Math.round((cfg.limits?.breaker?.pauseMs || 600000) / 1000)}s`);
    }
    breakers.set(key, b);
  }

  function pushRecent(key, item) {
    const arr = recent.get(key) ?? [];
    arr.push({ ...item, time: nowMs() });
    const cap = Math.max(4, Number(cfg.persona?.context?.recentMessages) || 20);
    while (arr.length > cap) arr.shift();
    recent.set(key, arr);
  }

  function enqueue(key, task) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(key, next);
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
    return next;
  }

  async function handleMessage(payload) {
    const isGroup = payload.message_type === 'group';
    const isPrivate = payload.message_type === 'private';
    if (!isGroup && !isPrivate) return;

    const userId = Number(payload.user_id);
    if (userId === client.selfQQ) return;
    if (cfg.allow.denyUsers.includes(userId)) {
      log.debug(`忽略黑名单用户 ${userId}`);
      return;
    }

    let key;
    let target;
    if (isGroup) {
      const groupId = Number(payload.group_id);
      if (!isGroupAllowed(cfg, groupId)) {
        log.debug(`忽略非白名单群 ${groupId}`);
        return;
      }
      key = `group:${groupId}`;
      target = { kind: 'group', id: groupId };
    } else {
      if (!isPrivateAllowed(cfg, userId)) {
        log.debug(`忽略非白名单私聊 ${userId}`);
        return;
      }
      key = `private:${userId}`;
      target = { kind: 'private', id: userId };
    }

    const raw = segmentsToText(payload.message);
    const text = cleanIncoming(raw, {
      maxChars: cfg.injection?.maxCharsPerMessage || 500,
      stripZeroWidth: cfg.injection?.stripZeroWidth !== false
    });
    if (!text) return;
    if (hitsKeyword(text, cfg.allow.denyKeywords)) {
      log.debug(`命中屏蔽词，忽略（${key}）`);
      return;
    }

    const senderName = payload.sender?.card || payload.sender?.nickname || String(userId);
    const isAtSelf = isGroup
      && String(payload.raw_message ?? '').includes(`[CQ:at,qq=${client.selfQQ}]`);

    pushRecent(key, { sender: senderName, text, isSelf: false });

    if (budgetExhausted(cfg)) {
      log.warn(`(${key}) 每日预算已耗尽，跳过`);
      return;
    }
    if (breakerBlocked(key)) {
      log.warn(`(${key}) 熔断中，跳过`);
      return;
    }
    const gate = allowRound(key);
    if (!gate.ok) {
      log.warn(`(${key}) ${gate.reason}，本条丢弃`);
      return;
    }

    enqueue(key, async () => {
      const lines = buildRecentLines(
        recent.get(key) ?? [],
        cfg.persona?.context?.maxCharsPerMessage || 200
      );
      if (isAtSelf) lines.push('（注：这条消息 @ 了你）');
      if (target.kind === 'private') lines.push('（注：这是私聊，对面是你的朋友）');

      const result = await runTurn({
        cfg,
        system: buildSystemPrompt(cfg),
        user: wrapAsData(lines)
      });

      if (!result.ok) {
        noteFailure(key);
        log.warn(`(${key}) 本轮失败：${result.reason}`);
        return;
      }
      const out = result.text.trim();
      if (!out || out === SILENT) {
        log.info(`(${key}) 模型选择不说话`);
        return;
      }
      pushRecent(key, { sender: cfg.identity?.nickname || '小鲸鱼', text: out, isSelf: true });

      const sent = target.kind === 'group'
        ? await sendToGroup(client, cfg, target.id, out)
        : await sendToPrivate(client, cfg, target.id, out);
      log.info(`(${key}) 回复 ${out.length} 字，发送 成功${sent.sent} 拦截${sent.blocked} 失败${sent.failed}`);
      if (sent.failed) noteFailure(key);
    });
  }

  /** 给控制接口用：当前有哪些会话、各存了多少条上下文。 */
  function listContexts() {
    return [...recent.entries()].map(([key, arr]) => ({
      key,
      count: arr.length,
      lastAt: arr.length ? arr[arr.length - 1].time : 0,
      preview: arr.length ? String(arr[arr.length - 1].text ?? '').slice(0, 60) : ''
    })).sort((a, b) => b.lastAt - a.lastAt);
  }

  /** 清掉某个会话（key 为空则全清）的上下文与限流计数。 */
  function clearContext(key) {
    if (key) {
      recent.delete(key);
      counters.delete(key);
      breakers.delete(key);
      return 1;
    }
    const n = recent.size;
    recent.clear();
    counters.clear();
    breakers.clear();
    return n;
  }

  return { handleMessage, listContexts, clearContext, _recent: recent, _queues: queues };
}
