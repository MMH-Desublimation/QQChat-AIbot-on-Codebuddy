// 配置读写：唯一入口。GUI 与运行时共用，保证"界面上看到的就是实际生效的"。
//
// 约定：
//   · 配置文件是 config/config.json（不含任何凭据）
//   · 读取时与内置默认值深合并，新增字段不会因为旧配置缺字段而崩
//   · 写入一律整体重写（原子替换），避免半截文件
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './secrets.js';

/**
 * 配置分两层，目的是"开源模板"和"本机私有值"分离：
 *   · config/config.json       —— 模板，**不含任何真实群号/QQ号**，可以安全提交；
 *   · config/config.local.json —— 本机真实值，已在 .gitignore 里，界面保存也写这里。
 * 读取时先模板、再用 local 覆盖；没 local 就直接用模板。
 */
export const CONFIG_FILE = path.join(ROOT, 'config', 'config.json');
export const LOCAL_CONFIG_FILE = path.join(ROOT, 'config', 'config.local.json');

function readJsonFile(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

export const DEFAULTS = {
  onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: '', selfQQ: 0 },
  identity: { ownerQQ: 0, roleCard: 'roles/小鲸鱼.md', nickname: '' },
  mode: 'chat',
  model: { name: 'deepseek-v4.1-flash', effort: 'high' },
  limits: {
    maxTurnsPerRound: 4,
    roundsPerMinutePerGroup: 6,
    roundsPerHourPerGroup: 60,
    dailyTokenBudget: 8000000,
    sessionMaxTokens: { chat: 120000, persona: 300000 },
    breaker: { failures: 3, pauseMs: 600000 }
  },
  send: {
    maxCharsPerMessage: 500,
    splitIntervalMinMs: 1000,
    splitIntervalMaxMs: 3000,
    replyDelayMinMs: 800,
    replyDelayMaxMs: 2500
  },
  allow: {
    groups: [], private: [], denyUsers: [], denyKeywords: [], mustReplyKeywords: []
  },
  persona: {
    wake: {
      probability: 0, atMention: true, nameMention: true, question: false, poke: true,
      keywords: [], batchWindowMs: 8000, wakePerMinute: 1, wakePerHour: 12, replyCheckMs: 180000
    },
    context: { recentMessages: 20, maxCharsPerMessage: 200 }
  },
  // 唯一的对外能力：浅层搜索。关掉后模型连工具定义都看不到。
  search: { enabled: true },
  injection: { stripZeroWidth: true, maxCharsPerMessage: 500, wrapAsData: true },
  ui: { host: '127.0.0.1', port: 3100, consoleToken: '' }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：src 覆盖 base，只递归普通对象。 */
function merge(base, src) {
  if (!isPlainObject(src)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(src)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** 把用户可能写成字符串的 QQ 号/群号统一成数字数组，去掉非法项。 */
function toIdList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => String(v).trim())
    .filter((v) => /^\d{5,12}$/.test(v))
    .map(Number);
}

let cached = null;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;
  let raw = readJsonFile(CONFIG_FILE) ?? {};
  const local = readJsonFile(LOCAL_CONFIG_FILE);
  if (local) raw = merge(raw, local);
  const cfg = merge(DEFAULTS, raw);
  // 规范化：白名单/黑名单一律数字数组，避免"字符串群号永远匹配不上"的经典坑
  cfg.allow.groups = toIdList(cfg.allow.groups);
  cfg.allow.private = toIdList(cfg.allow.private);
  cfg.allow.denyUsers = toIdList(cfg.allow.denyUsers);
  cfg.allow.denyKeywords = (cfg.allow.denyKeywords ?? []).map((s) => String(s)).filter(Boolean);
  cfg.allow.mustReplyKeywords = (cfg.allow.mustReplyKeywords ?? []).map((s) => String(s)).filter(Boolean);
  cfg.persona.wake.keywords = (cfg.persona.wake.keywords ?? []).map((s) => String(s)).filter(Boolean);
  cfg.onebot.selfQQ = Number(cfg.onebot.selfQQ) || 0;
  cfg.identity.ownerQQ = Number(cfg.identity.ownerQQ) || 0;
  cfg.limits.dailyTokenBudget = Math.max(0, Number(cfg.limits.dailyTokenBudget) || 0);
  cfg.mode = cfg.mode === 'persona' ? 'persona' : 'chat';
  cached = cfg;
  return cfg;
}

/** 原子写入：先写临时文件再替换，避免中途断电留下半截 JSON。 */
export function saveConfig(patch) {
  const current = loadConfig();
  const next = merge(current, patch);
  fs.mkdirSync(path.dirname(LOCAL_CONFIG_FILE), { recursive: true });
  const tmp = `${LOCAL_CONFIG_FILE}.tmp`;
  // 界面/程序写入的永远是本机私有文件，模板（config.json）保持原样，
  // 这样"改配置"不会把真实群号写回会被提交的那份。
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, LOCAL_CONFIG_FILE);
  cached = null;
  return loadConfig({ reload: true });
}

/** 供 GUI/日志使用的脱敏快照（不含任何凭据）。 */
export function publicConfig() {
  const cfg = loadConfig();
  const { accessToken, ...onebotSafe } = cfg.onebot;
  return {
    ...cfg,
    onebot: { ...onebotSafe, hasAccessToken: Boolean(accessToken) },
    ui: { ...cfg.ui, hasConsoleToken: Boolean(cfg.ui.consoleToken) }
  };
}

/** 群号是否放行（白名单为空=不放行，fail-closed）。 */
export function isGroupAllowed(cfg, groupId) {
  const id = Number(groupId);
  return cfg.allow.groups.includes(id);
}

/** 私聊是否放行。 */
export function isPrivateAllowed(cfg, userId) {
  const id = Number(userId);
  return cfg.allow.private.includes(id) || id === cfg.identity.ownerQQ;
}
