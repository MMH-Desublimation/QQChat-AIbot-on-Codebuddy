// 统一日志：控制台 + 文件（JSONL），所有文本强制过 redact()。
// 任何模块都不要再直接 console.log —— 否则凭据/路径可能漏出去。
import fs from 'node:fs';
import path from 'node:path';
import { redact, ROOT } from './secrets.js';

const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

let stream = null;

function ensureStream() {
  if (stream) return stream;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  return stream;
}

const LEVEL_TAG = { debug: '·', info: 'i', warn: '!', error: '×' };

function write(level, scope, message, extra) {
  const entry = {
    t: new Date().toISOString(),
    lv: level,
    sc: scope,
    msg: redact(message)
  };
  if (extra && typeof extra === 'object') entry.d = sanitize(extra);

  if (level === 'error' || level === 'warn') {
    console.error(`${LEVEL_TAG[level]} [${scope}] ${entry.msg}`);
  } else {
    console.log(`${LEVEL_TAG[level]} [${scope}] ${entry.msg}`);
  }
  try {
    ensureStream().write(`${JSON.stringify(entry)}\n`);
  } catch {
    // 写盘失败不影响运行
  }
}

/** 递归脱敏对象里的字符串（避免把 token/路径写进日志文件）。 */
function sanitize(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|key|secret|authorization/i.test(k)) out[k] = '***';
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 建一个带作用域的 logger。 */
export function createLogger(scope) {
  return {
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d)
  };
}

export const logFile = LOG_FILE;
