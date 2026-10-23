// 凭据存取：唯一入口。
//
// 设计目标（按用户要求）：
//   1. 源码里不出现任何 key —— 只从环境变量或 data/secrets.json 读；
//   2. 程序界面只显示掩码，永不回显完整值；
//   3. 日志里出现的 key 一律打码（redact() 供 logger 复用）；
//   4. 别人拿到这份代码，仓库里没有任何可用凭据（data/ 与 .env 都被 .gitignore 排除）。
//
// 优先级：process.env.CODEBUDDY_API_KEY > data/secrets.json。
// 想完全不落盘的话，只设环境变量即可，本模块不会写文件。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

/** 只显示首尾，中间打码。长度很短时全打码，避免"掩码本身泄露太多"。 */
export function mask(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 10) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 把文本里形似凭据的片段打码（日志/异常信息统一走这里）。 */
export function redact(text) {
  let out = String(text ?? '');
  // 我们自己认识的凭据格式
  out = out.replace(/ck_[A-Za-z0-9._-]{8,}/g, (m) => mask(m));
  // 通用长串（sk- 等）
  out = out.replace(/\b(sk|pk|ak)-[A-Za-z0-9._-]{12,}/g, (m) => mask(m));
  // 显式环境变量赋值
  out = out.replace(/(CODEBUDDY_API_KEY|CODEBUDDY_AUTH_TOKEN)\s*=\s*\S+/g, '$1=***');
  return out;
}

function readSecretsFile() {
  try {
    let text = fs.readFileSync(SECRETS_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 取 API Key。返回值只应传给 SDK 的 env，不要打日志、不要回给前端。
 * @returns {{ key: string, source: 'env' | 'file' | 'none' }}
 */
export function getApiKey() {
  const fromEnv = String(process.env.CODEBUDDY_API_KEY ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromFile = String(readSecretsFile().codebuddyApiKey ?? '').trim();
  if (fromFile) return { key: fromFile, source: 'file' };
  return { key: '', source: 'none' };
}

/** 前端/日志用的状态快照：只有掩码与来源，没有明文。 */
export function apiKeyStatus() {
  const { key, source } = getApiKey();
  return { configured: Boolean(key), masked: mask(key), source };
}

/**
 * 保存 API Key（写 data/secrets.json，权限收紧到当前用户）。
 * @param {string} key
 */
export function saveApiKey(key) {
  const value = String(key ?? '').trim();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = readSecretsFile();
  if (value) current.codebuddyApiKey = value;
  else delete current.codebuddyApiKey;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), 'utf8');
  try {
    // Windows：只给当前用户读写，避免同机其他账户读走
    execFileSync('icacls', [SECRETS_FILE, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' });
  } catch {
    // 收紧失败不阻塞；文件本身已在 .gitignore 里
  }
  return apiKeyStatus();
}

export const paths = { DATA_DIR, SECRETS_FILE };
