// 本地图形界面后端。
//
// 职责：把「启停 / 配置 / 人设 / 名单 / 凭据 / 用量」收成一个回环 HTTP 服务，
// 浏览器只跟它打交道；真正的 QQ 桥接是它 spawn 出来的子进程，所以界面上能
// 直接开关，不需要去点黑窗口。
//
// 安全：只监听 127.0.0.1；所有请求必须带 x-ui-token 或 ?token=；
// 凭据只以掩码形式返回，写入走 secrets.saveApiKey。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, publicConfig } from '../config.js';
import { apiKeyStatus, saveApiKey, ROOT } from '../secrets.js';
import { usageToday, budgetExhausted, LOCKED_MODEL } from '../agent/runner.js';
import { createLogger } from '../logger.js';

const log = createLogger('ui');
const PORT = Number(process.env.QQ_AGENT_UI_PORT) || 3100;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');
const TOKEN_FILE = path.join(ROOT, 'data', 'ui-token');
const NAPCAT_BAT = path.join(ROOT, '..', 'napcat', '启动NapCat.bat');

// ── 访问令牌 ───────────────────────────────────────────────────────────
function ensureToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch { /* 不存在就生成 */ }
  const t = crypto.randomBytes(18).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, 'utf8');
  return t;
}
const TOKEN = ensureToken();

// ── 子进程管理 ─────────────────────────────────────────────────────────
let agentProc = null;
let agentStartedAt = 0;
/** 用户点了「停止」时置真：用于区分"主动停"和"崩了"，崩了才自动拉起。 */
let stoppingRequested = false;
const agentLogs = [];
const LOG_CAP = 200;

function pushLog(line) {
  const text = String(line ?? '').replace(/\s+$/, '');
  if (!text) return;
  agentLogs.push({ t: Date.now(), text });
  while (agentLogs.length > LOG_CAP) agentLogs.shift();
}

function agentRunning() {
  return Boolean(agentProc && agentProc.exitCode === null && !agentProc.killed);
}

function startAgent() {
  if (agentRunning()) return { ok: true, already: true };
  const entry = path.join(ROOT, 'src', 'index.js');
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, QQ_AGENT_UI: '1' },
    windowsHide: true
  });
  agentProc = child;
  agentStartedAt = Date.now();
  stoppingRequested = false;
  pushLog(`[ui] 启动 agent pid=${child.pid}`);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => String(chunk).split(/\r?\n/).forEach(pushLog));
  child.stderr.on('data', (chunk) => String(chunk).split(/\r?\n/).forEach(pushLog));
  child.on('close', (code) => {
    pushLog(`[ui] agent 退出 code=${code}`);
    if (agentProc === child) agentProc = null;
    agentStartedAt = 0;
    // 意外退出自动拉起（用户点「停止」不算）。没有这层，一次 OneBot 抖动就会
    // 让对话进程彻底消失，界面上看着"怎么不回了"却没有任何提示。
    if (!stoppingRequested && process.env.QQ_AGENT_AUTOSTART !== '0') {
      pushLog('[ui] 检测到异常退出，3 秒后自动重启');
      setTimeout(() => {
        if (!agentRunning() && !stoppingRequested) startAgent();
      }, 3000);
    }
  });
  child.on('error', (error) => pushLog(`[ui] agent 启动失败：${error?.message ?? error}`));
  return { ok: true, pid: child.pid };
}

function stopAgent() {
  if (!agentRunning()) return { ok: true, already: true };
  const child = agentProc;
  stoppingRequested = true;
  pushLog('[ui] 停止 agent…');
  try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
  return { ok: true, pid: child.pid };
}

// ── 端口探测 ───────────────────────────────────────────────────────────
import net from 'node:net';

function portOpen(port, timeout = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function napcatState() {
  const [webui, http3000, ws3001] = await Promise.all([portOpen(6099), portOpen(3000), portOpen(3001)]);
  return { webui, http: http3000, ws: ws3001, ready: http3000 && ws3001 };
}

// ── 工具 ───────────────────────────────────────────────────────────────
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function authed(req, url) {
  const token = String(req.headers['x-ui-token'] ?? url.searchParams.get('token') ?? '');
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── 静态页 ─────────────────────────────────────────────────────────────
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
    return send(res, 200, data, type);
  } catch {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

// ── 路由 ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    return serveStatic(req, res, url.pathname);
  }
  if (!authed(req, url)) {
    return send(res, 401, { error: 'unauthorized', hint: '用 http://127.0.0.1:3100/?token=<data/ui-token> 打开' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const cfg = loadConfig({ reload: true });
      const usage = usageToday();
      const napcat = await napcatState();
      return send(res, 200, {
        agent: {
          running: agentRunning(),
          pid: agentRunning() ? agentProc.pid : null,
          uptimeMs: agentRunning() ? Date.now() - agentStartedAt : 0
        },
        napcat,
        mode: cfg.mode,
        model: LOCKED_MODEL,
        effort: cfg.model?.effort ?? 'high',
        usage: { ...usage, budget: cfg.limits.dailyTokenBudget, exhausted: budgetExhausted(cfg) },
        logs: agentLogs.slice(-60)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/agent/start') return send(res, 200, startAgent());
    if (req.method === 'POST' && url.pathname === '/api/agent/stop') return send(res, 200, stopAgent());
    if (req.method === 'POST' && url.pathname === '/api/agent/restart') {
      stopAgent();
      await new Promise((r) => setTimeout(r, 1200));
      return send(res, 200, startAgent());
    }

    if (req.method === 'POST' && url.pathname === '/api/napcat/start') {
      if (!fs.existsSync(NAPCAT_BAT)) return send(res, 400, { error: `找不到 ${NAPCAT_BAT}` });
      // 独立窗口启动：需要人工扫码，不能在后台静默跑
      spawn('cmd.exe', ['/c', 'start', '', NAPCAT_BAT], { cwd: path.dirname(NAPCAT_BAT), detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true, hint: '已打开 NapCat 窗口，请按提示扫码登录' });
    }

    // ── 上下文管理：代理到 agent 的控制口（3101），界面不直接碰它 ──
    if (req.method === 'GET' && url.pathname === '/api/contexts') {
      try {
        const r = await fetch('http://127.0.0.1:3101/contexts', {
          headers: { 'x-control-token': TOKEN },
          signal: AbortSignal.timeout(3000)
        });
        return send(res, 200, await r.json());
      } catch {
        return send(res, 200, { contexts: [], offline: true });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/contexts/clear') {
      const body = await readBody(req);
      try {
        const r = await fetch('http://127.0.0.1:3101/contexts/clear', {
          method: 'POST',
          headers: { 'x-control-token': TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(5000)
        });
        return send(res, 200, await r.json());
      } catch {
        return send(res, 503, { error: '对话进程未运行，无法清除' });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { config: publicConfig(), apikey: apiKeyStatus(), lockedModel: LOCKED_MODEL });
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const patch = await readBody(req);
      // 模型名不允许从界面改：白名单式过滤，避免误改成别的（更贵的）模型
      if (patch?.model && typeof patch.model === 'object') delete patch.model.name;
      const saved = saveConfig(patch);
      log.info('配置已更新');
      return send(res, 200, { ok: true, config: publicConfig(), effort: saved.model?.effort });
    }

    if (req.method === 'POST' && url.pathname === '/api/apikey') {
      const body = await readBody(req);
      const key = String(body?.key ?? '').trim();
      if (key && !/^ck_[A-Za-z0-9._-]{10,}$/.test(key)) {
        return send(res, 400, { error: 'Key 格式看起来不对（应以 ck_ 开头）' });
      }
      const status = saveApiKey(key);
      log.info(key ? 'API Key 已更新' : 'API Key 已清除');
      return send(res, 200, { ok: true, apikey: status });
    }

    if (req.method === 'GET' && url.pathname === '/api/role') {
      const cfg = loadConfig({ reload: true });
      const file = path.join(ROOT, cfg.identity?.roleCard || 'roles/小鲸鱼.md');
      try {
        return send(res, 200, { path: cfg.identity?.roleCard, text: fs.readFileSync(file, 'utf8') });
      } catch (error) {
        return send(res, 404, { error: `读不到角色卡：${error?.message ?? error}` });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/role') {
      const cfg = loadConfig({ reload: true });
      const body = await readBody(req);
      const text = String(body?.text ?? '');
      const file = path.join(ROOT, cfg.identity?.roleCard || 'roles/小鲸鱼.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      log.info(`角色卡已保存（${text.length} 字）`);
      return send(res, 200, { ok: true, length: text.length });
    }

    return send(res, 404, { error: 'not found' });
  } catch (error) {
    log.error(`接口失败 ${url.pathname}：${error?.message ?? error}`);
    return send(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  log.info(`图形界面：${url}`);
  console.log(`\n  打开这个地址（已带访问令牌）：\n  ${url}\n`);

  // 一键启动：界面起来后顺手把对话进程拉起来，省掉再点一次
  if (process.env.QQ_AGENT_AUTOSTART !== '0') {
    setTimeout(() => {
      if (!agentRunning()) {
        startAgent();
        log.info('已自动启动对话进程（可用界面上的「停止对话」关闭）');
      }
    }, 1500);
  }
});

process.on('SIGINT', () => {
  stopAgent();
  process.exit(0);
});
