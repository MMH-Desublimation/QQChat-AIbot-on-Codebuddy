// 发送层：分条、节流、重试、出站审计。
// 业务代码只调用 sendToGroup / sendToPrivate，不要直接碰 client.call。
import { auditOutgoing } from '../safety/guard.js';
import { createLogger } from '../logger.js';

const log = createLogger('send');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

/**
 * 把一段文本切成若干条，每条不超过 maxChars。
 * 切分优先落在换行、句末标点，其次硬切，避免把词拆断。
 */
export function splitText(text, maxChars = 500) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  if (raw.length <= maxChars) return [raw];

  const chunks = [];
  let rest = raw;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    // 在所有候选标点里取"最靠后且不太靠前"的断点；都太靠前就硬切，
    // 避免切出一堆只有三五个字的碎片。
    let cut = -1;
    for (const mark of ['\n', '。', '！', '？', '；', '.', '!', '?']) {
      const idx = window.lastIndexOf(mark);
      if (idx >= 10 && idx + 1 > cut) cut = idx + 1;
    }
    if (cut === -1) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * 发到群：分条 + 随机间隔 + 逐条审计。
 * @returns {Promise<{sent:number, blocked:number, failed:number}>}
 */
export async function sendToGroup(client, cfg, groupId, text) {
  return sendSplit(client, cfg, (chunk) => client.sendGroup(groupId, chunk), text, `group:${groupId}`);
}

/** 发到私聊。 */
export async function sendToPrivate(client, cfg, userId, text) {
  return sendSplit(client, cfg, (chunk) => client.sendPrivate(userId, chunk), text, `private:${userId}`);
}

async function sendSplit(client, cfg, deliver, text, key) {
  const maxChars = Math.max(50, Number(cfg.send?.maxCharsPerMessage) || 500);
  const minGap = Math.max(0, Number(cfg.send?.splitIntervalMinMs) || 1000);
  const maxGap = Math.max(minGap, Number(cfg.send?.splitIntervalMaxMs) || 3000);

  const chunks = splitText(text, maxChars);
  const result = { sent: 0, blocked: 0, failed: 0 };

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const audit = auditOutgoing(chunk);
    if (!audit.ok) {
      result.blocked += 1;
      log.warn(`出站拦截(${key})：命中「${audit.reason}」`, { preview: chunk.slice(0, 40) });
      continue;
    }
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
      try {
        await deliver(chunk);
        ok = true;
      } catch (error) {
        log.warn(`发送失败(${key}) 第${attempt + 1}次：${error?.message ?? error}`);
        if (attempt === 0) await sleep(800);
      }
    }
    if (ok) result.sent += 1;
    else result.failed += 1;

    if (i < chunks.length - 1) await sleep(rand(minGap, maxGap));
  }
  return result;
}
