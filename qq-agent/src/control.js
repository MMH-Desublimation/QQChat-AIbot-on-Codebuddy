// 本地控制接口（127.0.0.1:3101），只给图形界面用。
//
// 为什么要单独一个端口：GUI 是独立进程，agent 是它 spawn 的子进程，
// 界面上要"看当前有哪些会话、清掉某个群的上下文"，必须有个通道进到 agent 内存里。
//
// 安全：只监听回环；token 复用 data/ui-token（与 GUI 同一个，不额外增加凭据面）。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { ROOT } from './secrets.js';

const log = createLogger('control');
const TOKEN_FILE = path.join(ROOT, 'data', 'ui-token');

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function authed(req) {
  const token = readToken();
  if (!token) return true; // 没有令牌文件时视为本机自用（GUI 会先生成）
  const supplied = String(req.headers['x-control-token'] ?? '');
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {{listContexts:Function, clearContext:Function}} opts.engine
 */
export function startControlServer({ port = 3101, engine }) {
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (!authed(req)) return send(401, { error: 'unauthorized' });

    try {
      if (req.method === 'GET' && req.url?.startsWith('/contexts')) {
        return send(200, { contexts: engine.listContexts?.() ?? [] });
      }
      if (req.method === 'POST' && req.url?.startsWith('/contexts/clear')) {
        const body = await readBody(req);
        const key = body?.key ? String(body.key) : '';
        const cleared = engine.clearContext?.(key) ?? 0;
        log.info(key ? `已清除上下文 ${key}` : `已清除全部上下文（${cleared} 个会话）`);
        return send(200, { ok: true, cleared });
      }
      return send(404, { error: 'not found' });
    } catch (error) {
      log.error(`控制接口失败：${error?.message ?? error}`);
      return send(500, { error: String(error?.message ?? error) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info(`控制接口：http://127.0.0.1:${port}`);
  });
  return server;
}
