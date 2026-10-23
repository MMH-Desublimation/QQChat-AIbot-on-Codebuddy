// 拟真模式：默认潜水，只在"被点名"时才醒来决定要不要说话。
//
// 核心设计：**唤醒判定是纯本地规则，零 token**。
// 群里的每条消息只进本地缓冲（不调用模型），只有命中触发条件才真正唤醒一轮。
// 这样即使群里刷几百条，只要没人理她，费用就是 0。
//
// 状态机：diving（潜水、只缓冲）→ 命中 → active（跑一轮模型）→ 回到 diving
import { isGroupAllowed, isPrivateAllowed } from '../config.js';
import { segmentsToText } from '../onebot/client.js';
import { cleanIncoming, wrapAsData, hitsKeyword } from '../safety/guard.js';
import { buildSystemPrompt, buildRecentLines } from '../agent/persona.js';
import { runTurn, budgetExhausted } from '../agent/runner.js';
import { sendToGroup, sendToPrivate } from '../onebot/sender.js';
import { createLogger } from '../logger.js';

const log = createLogger('persona');
const SILENT = '[SILENT]';

/** 名字被提到（角色卡里的自称 + 配置里的关键词）。 */
export function mentionedBy(text, cfg) {
  const names = [
    cfg.identity?.nickname,
    '小鲸鱼',
    '大肥鱼',
    ...(cfg.persona?.wake?.keywords ?? [])
  ].filter((n) => n && String(n).trim());
  const lower = String(text ?? '').toLowerCase();
  return names.some((n) => lower.includes(String(n).toLowerCase()));
}

/** 疑问句判定（很轻的启发式，够用就行）。 */
export function looksLikeQuestion(text) {
  return /[?？]|吗|呢|怎么|如何|为什么|为啥|有没有|能不能|是不是/.test(String(text ?? ''));
}

export function createPersonaMode({ cfg, client }) {
  /** key -> [{sender,text,isSelf,time}] 潜水期间的消息缓冲（不花钱） */
  const buffer = new Map();
  /** key -> number[] 唤醒时间戳（限流用） */
  const wakeTimes = new Map();
  /** key -> Promise 串行队列 */
  const queues = new Map();
  /** key -> 最近一次唤醒时间，便于观察 */
  const lastWakeAt = new Map();

  const nowMs = () => Date.now();

  function pushBuffer(key, item) {
    const arr = buffer.get(key) ?? [];
    arr.push({ ...item, time: nowMs() });
    const cap = Math.max(10, Number(cfg.persona?.context?.recentMessages) || 20);
    while (arr.length > cap) arr.shift();
    buffer.set(key, arr);
  }

  function wakeAllowed(key) {
    const w = cfg.persona?.wake ?? {};
    const times = (wakeTimes.get(key) ?? []).filter((t) => nowMs() - t < 3600000);
    const perMin = Number(w.wakePerMinute) || 1;
    const perHour = Number(w.wakePerHour) || 12;
    const lastMinute = times.filter((t) => nowMs() - t < 60000).length;
    if (lastMinute >= perMin) return { ok: false, reason: `每分钟唤醒上限 ${perMin}` };
    if (times.length >= perHour) return { ok: false, reason: `每小时唤醒上限 ${perHour}` };
    times.push(nowMs());
    wakeTimes.set(key, times);
    return { ok: true };
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

  /** 判定这次消息要不要唤醒。返回原因字符串或 null。 */
  function decide(msg) {
    const w = cfg.persona?.wake ?? {};
    if (msg.isPoke && w.poke) return 'poke';
    if (msg.isAtSelf && w.atMention) return 'atMention';
    if (w.nameMention && mentionedBy(msg.text, cfg)) return 'nameMention';

    const kw = (w.keywords ?? []).find((k) => k && String(msg.text).toLowerCase().includes(String(k).toLowerCase()));
    if (kw) return `keyword:${kw}`;

    if (w.question && looksLikeQuestion(msg.text)) return 'question';

    const p = Number(w.probability) || 0;
    if (p > 0 && Math.random() < p) return 'probability';

    return null;
  }

  /** 真正唤醒一轮：把潜水期间的缓冲交给模型，让它决定发言还是继续潜。 */
  function runWake(key, target, reason) {
    lastWakeAt.set(key, nowMs());
    log.info(`(${key}) 唤醒（${reason}）`);

    enqueue(key, async () => {
      const lines = buildRecentLines(buffer.get(key) ?? [], cfg.persona?.context?.maxCharsPerMessage || 200);
      const result = await runTurn({
        cfg,
        system: buildSystemPrompt(cfg, { persona: true }),
        user: wrapAsData(lines)
      });

      if (!result.ok) {
        log.warn(`(${key}) 本轮失败：${result.reason}`);
        return;
      }
      const out = result.text.trim();
      if (!out || out === SILENT) {
        log.info(`(${key}) 醒了但选择继续潜水`);
        return;
      }
      pushBuffer(key, { sender: cfg.identity?.nickname || '小鲸鱼', text: out, isSelf: true });
      const sent = target.kind === 'group'
        ? await sendToGroup(client, cfg, target.id, out)
        : await sendToPrivate(client, cfg, target.id, out);
      log.info(`(${key}) 发言 ${out.length} 字（成功${sent.sent} 拦截${sent.blocked} 失败${sent.failed}）`);
    });
  }

  async function handleMessage(payload) {
    const isGroup = payload.message_type === 'group';
    const isPrivate = payload.message_type === 'private';
    if (!isGroup && !isPrivate) return;

    const userId = Number(payload.user_id);
    if (userId === client.selfQQ) return;
    if (cfg.allow.denyUsers.includes(userId)) return;

    let key;
    let target;
    if (isGroup) {
      const groupId = Number(payload.group_id);
      if (!isGroupAllowed(cfg, groupId)) return;
      key = `group:${groupId}`;
      target = { kind: 'group', id: groupId };
    } else {
      if (!isPrivateAllowed(cfg, userId)) return;
      key = `private:${userId}`;
      target = { kind: 'private', id: userId };
    }

    const text = cleanIncoming(segmentsToText(payload.message), {
      maxChars: cfg.injection?.maxCharsPerMessage || 500,
      stripZeroWidth: cfg.injection?.stripZeroWidth !== false
    });
    if (!text) return;
    if (hitsKeyword(text, cfg.allow.denyKeywords)) return;

    const senderName = payload.sender?.card || payload.sender?.nickname || String(userId);
    const isAtSelf = isGroup && String(payload.raw_message ?? '').includes(`[CQ:at,qq=${client.selfQQ}]`);

    // 私聊等于"直接找我"，必然唤醒（否则私聊永远没人理）
    const reason = isPrivate ? 'private' : decide({ text, isAtSelf, isPoke: false });

    pushBuffer(key, { sender: senderName, text, isSelf: false });

    if (!reason) {
      log.debug(`(${key}) 潜水：${text.slice(0, 20)}`);
      return;
    }
    if (budgetExhausted(cfg)) {
      log.warn(`(${key}) 每日预算已耗尽，跳过唤醒`);
      return;
    }
    const gate = wakeAllowed(key);
    if (!gate.ok) {
      log.warn(`(${key}) 唤醒被限流（${gate.reason}），原因 ${reason} 已丢弃`);
      return;
    }
    runWake(key, target, reason);
  }

  /** 拍一拍：NapCat 通过 notice 事件推过来，不走 message 通道。 */
  async function handlePoke(payload) {
    if (!cfg.persona?.wake?.poke) return;
    const groupId = Number(payload.group_id);
    if (!groupId) return;
    if (!isGroupAllowed(cfg, groupId)) return;
    if (Number(payload.target_id) && Number(payload.target_id) !== Number(client.selfQQ)) return;

    const key = `group:${groupId}`;
    if (budgetExhausted(cfg)) return;
    const gate = wakeAllowed(key);
    if (!gate.ok) {
      log.warn(`(${key}) 拍一拍唤醒被限流（${gate.reason}）`);
      return;
    }
    pushBuffer(key, { sender: '系统', text: '（有人拍了拍你）', isSelf: false });
    runWake(key, { kind: 'group', id: groupId }, 'poke');
  }

  /** 给控制接口用：当前有哪些会话、潜水期间攒了多少条。 */
  function listContexts() {
    return [...buffer.entries()].map(([key, arr]) => ({
      key,
      count: arr.length,
      lastAt: arr.length ? arr[arr.length - 1].time : 0,
      lastWakeAt: lastWakeAt.get(key) ?? 0,
      preview: arr.length ? String(arr[arr.length - 1].text ?? '').slice(0, 60) : ''
    })).sort((a, b) => b.lastAt - a.lastAt);
  }

  /** 清上下文（key 为空则全清）。唤醒限流也一并重置——用户点"清空"通常就是想重新开始。 */
  function clearContext(key) {
    if (key) {
      buffer.delete(key);
      wakeTimes.delete(key);
      lastWakeAt.delete(key);
      return 1;
    }
    const n = buffer.size;
    buffer.clear();
    wakeTimes.clear();
    lastWakeAt.clear();
    return n;
  }

  return { handleMessage, handlePoke, listContexts, clearContext, _buffer: buffer, _lastWakeAt: lastWakeAt };
}
