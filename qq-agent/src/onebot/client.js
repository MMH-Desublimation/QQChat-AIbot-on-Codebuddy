// OneBot v11 客户端（NapCat）。
//   · 事件：WebSocket 正向连接（NapCat 的「WebSocket 服务端」）
//   · 发送：HTTP POST（NapCat 的「HTTP 服务端」）
//
// 只依赖 Node 22 内置的全局 WebSocket，不引第三方包。
// 所有出站调用都走 call()，方便统一加超时与错误处理。
import { createLogger } from '../logger.js';

const log = createLogger('onebot');

/** OneBot 消息段 → 纯文本（图片/表情转成占位符，不在这里下载）。 */
export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return String(segments ?? '');
  const parts = [];
  for (const seg of segments) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    if (type === 'text') parts.push(String(data.text ?? ''));
    else if (type === 'at') {
      const qq = String(data.qq ?? '');
      parts.push(qq === 'all' ? '@全体成员' : `@${data.name ?? qq}`);
    } else if (type === 'image') parts.push('[图片]');
    else if (type === 'face') parts.push('[表情]');
    else if (type === 'mface') parts.push('[表情]');
    else if (type === 'reply') parts.push('');       // 引用由上层单独解析
    else if (type === 'forward') parts.push('[转发消息]');
    else if (type === 'record') parts.push('[语音]');
    else if (type === 'video') parts.push('[视频]');
    else if (type === 'file') parts.push('[文件]');
    // 其余类型忽略
  }
  return parts.join('').trim();
}

/** 从消息段里取被引用（reply）的消息 id。 */
export function replyTargetOf(segments) {
  if (!Array.isArray(segments)) return '';
  const seg = segments.find((s) => s?.type === 'reply');
  return seg ? String(seg.data?.id ?? '') : '';
}

export class OneBotClient {
  /**
   * @param {object} cfg loadConfig() 结果
   * @param {{onMessage?:Function,onNotice?:Function,onLifecycle?:Function}} handlers
   */
  constructor(cfg, handlers = {}) {
    this.cfg = cfg;
    this.handlers = handlers;
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.retryTimer = null;
    this.selfId = Number(cfg.onebot?.selfQQ) || 0;
  }

  get selfQQ() {
    return this.selfId;
  }

  async connect() {
    this.closed = false;
    this._open();
    // 兜底自愈：每 20 秒检查一次，连接已死却没有重连定时器时补一次。
    // 有些情况下 error/close 都不来（进程半死、NAT 掉了），光靠事件会一直哑着。
    setInterval(() => {
      if (this.closed) return;
      if (this.retryTimer) return;
      const state = this.ws?.readyState;
      if (state === undefined || state === 2 || state === 3) {
        log.warn(`连接状态异常（readyState=${state}），补一次重连`);
        this._open();
      }
    }, 20000);
  }

  _open() {
    const base = String(this.cfg.onebot?.wsUrl ?? 'ws://127.0.0.1:3001');
    const token = String(this.cfg.onebot?.accessToken ?? '');
    const url = token
      ? `${base}${base.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      : base;

    log.info(`连接 ${base}`);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      log.error(`WebSocket 构造失败：${error?.message ?? error}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      log.info('OneBot 已连接');
    });

    ws.addEventListener('message', (ev) => {
      let payload;
      try {
        payload = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this._dispatch(payload);
    });

    ws.addEventListener('close', () => {
      if (this.closed || this.ws !== ws) return;
      log.warn('OneBot 连接断开');
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      if (this.closed || this.ws !== ws) return;
      // 不能只等 close：实测 NapCat 还没起时，error 会触发但 close 不触发，
      // 于是重连逻辑永远等不到机会（表现就是日志里一次"连接出错"后再无动静）。
      log.warn('OneBot 连接出错，主动重连');
      try { ws.close(); } catch { /* 忽略 */ }
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.closed || this.retryTimer) return;
    this.retry = Math.min(this.retry + 1, 8);
    const delay = Math.min(30000, 1000 * 2 ** (this.retry - 1));
    log.info(`${delay}ms 后重连（第 ${this.retry} 次）`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this._open();
    }, delay);
    // 不要 unref：这是进程唯一的"活着"把手。unref 掉之后，OneBot 一断线，
    // Node 发现没有活跃 handle 就静默退出（exit code 0），看起来像"自己关了"。
  }

  _dispatch(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.self_id && !this.selfId) {
      this.selfId = Number(payload.self_id) || 0;
      log.info(`机器人 QQ：${this.selfId}`);
    }
    if (payload.post_type === 'message') {
      this.handlers.onMessage?.(payload);
    } else if (payload.post_type === 'notice') {
      this.handlers.onNotice?.(payload);
    } else if (payload.post_type === 'meta_event') {
      this.handlers.onLifecycle?.(payload);
    }
  }

  /** 调 OneBot HTTP API。 */
  async call(action, params = {}, { timeoutMs = 15000 } = {}) {
    const base = String(this.cfg.onebot?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const token = String(this.cfg.onebot?.accessToken ?? '');
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // NapCat 偶尔返回非 JSON（例如 401 页面）
    }
    if (!res.ok || !json) {
      throw new Error(`${action} 失败：HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const retcode = json.retcode ?? json.status;
    if (retcode !== undefined && retcode !== 0 && retcode !== 'ok' && retcode !== 'async') {
      throw new Error(`${action} 返回 retcode=${retcode} ${json.message ?? ''}`.trim());
    }
    return json.data ?? json;
  }

  /** 发群消息。message 可以是字符串或消息段数组。 */
  async sendGroup(groupId, message) {
    const payload = typeof message === 'string'
      ? [{ type: 'text', data: { text: message } }]
      : message;
    return this.call('send_group_msg', { group_id: Number(groupId), message: payload });
  }

  /** 发私聊消息。 */
  async sendPrivate(userId, message) {
    const payload = typeof message === 'string'
      ? [{ type: 'text', data: { text: message } }]
      : message;
    return this.call('send_private_msg', { user_id: Number(userId), message: payload });
  }

  close() {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // 忽略
    }
    this.ws = null;
  }
}
