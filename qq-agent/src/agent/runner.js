// Agent 执行端：把「一次对话回合」封装成 runTurn()。
//
// 这里是全部安全约束的落地点。任何调用都必须经过本文件，不允许业务代码直接
// import @tencent-ai/agent-sdk —— 否则 `tools: []` 那三道防线会被绕过。
//
// 安全参数固定（见《交接》03-安全基线.md）：
//   tools: []            → 内置代码工具物理消失（Bash/Read/Write/Edit/Glob/Grep）
//   disallowedTools      → 其余工具（WebFetch/Skill/Task/Agent/ComputerUse…）一并消失
//   canUseTool           → 只放行我们自建的 mcp__qq__*，其余 deny + interrupt
//   settingSources: []   → 不加载 settings/CODEBUDDY.md/MCP/agents/skills
//   cwd                  → 空沙箱目录，绝不指向工作区
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@tencent-ai/agent-sdk';
import { getApiKey, ROOT } from '../secrets.js';
import { createLogger } from '../logger.js';

const log = createLogger('agent');
const SANDBOX = path.join(ROOT, 'data', 'sandbox');
const USAGE_FILE = path.join(ROOT, 'data', 'usage.json');

/**
 * 模型锁死。
 *
 * 使用者明确要求：只走 deepseek-v4.1-flash，不许因为配置里写了别的名字就跑去调
 * 另一个模型（不同模型价格差好几倍，误调一次就是真金白银）。所以这里不接受
 * config.model.name，配置里写了别的值只会被忽略并告警。
 */
export const LOCKED_MODEL = 'deepseek-v4.1-flash';

/** 视作"必须物理移除"的其余工具（tools: [] 管不到的）。 */
export const DISALLOWED_TOOLS = [
  'WebFetch', 'WebSearch', 'Skill', 'SkillManage', 'Agent', 'Task',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'TaskOutput',
  'TeamCreate', 'TeamDelete', 'SendMessage', 'SendUserMessage',
  'Component', 'Mods', 'AskUserQuestion', 'AskUserForStructuredInput', 'StructuredOutput',
  'EnterPlanMode', 'ExitPlanMode', 'ComputerUse', 'REPL', 'LSP',
  'LibraryUpload', 'ImageGen', 'VideoGen', 'AudioTranscribe',
  'Artifact', 'ArtifactControl', 'ReportFindings', 'PushNotification',
  'WeChatReply', 'WeComReply', 'Workflow', 'Monitor',
  'CronCreate', 'CronDelete', 'CronList',
  'CreateColleague', 'CreateChannel', 'ListColleagues', 'MessageColleague',
  'SpeakInChannel', 'ChannelTasks',
  'A2AGetAgentCard', 'A2ASendMessage', 'A2AGetTask', 'A2ACancelTask'
];

import { MCP_SERVER_NAME, SELF_TOOL_PREFIX, qqToolServer } from './tools.js';

export { SELF_TOOL_PREFIX };

// ── 用量账本：按天累计，用于每日预算熔断 ──────────────────────────────
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readUsage() {
  try {
    const text = fs.readFileSync(USAGE_FILE, 'utf8');
    const parsed = JSON.parse(text);
    const key = todayKey();
    if (parsed?.date !== key) return { date: key, tokens: 0, rounds: 0 };
    return { date: key, tokens: Number(parsed.tokens) || 0, rounds: Number(parsed.rounds) || 0 };
  } catch {
    return { date: todayKey(), tokens: 0, rounds: 0 };
  }
}

function writeUsage(usage) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
  } catch {
    // 落盘失败不影响运行
  }
}

export function usageToday() {
  return readUsage();
}

/** 预算是否已耗尽（耗尽后只读不调用模型）。 */
export function budgetExhausted(cfg) {
  const budget = Number(cfg?.limits?.dailyTokenBudget ?? 0);
  if (!budget) return false;
  return readUsage().tokens >= budget;
}

/**
 * 跑一个回合。
 *
 * @param {object} opts
 * @param {object} opts.cfg        配置（loadConfig 结果）
 * @param {string} opts.system     系统提示（人设 + 安全规则）
 * @param {string} opts.user      用户侧内容（已包裹成"群友发言数据"）
 * @param {Array}  [opts.tools]    createSdkMcpServer 的结果（拟真模式用）
 * @param {Function} [opts.onText] 流式文本回调
 * @returns {Promise<{ok:boolean, text:string, tokens:number, reason?:string}>}
 */
export async function runTurn({ cfg, system, user, tools = [], onText }) {
  const { key, source } = getApiKey();
  if (!key) return { ok: false, text: '', tokens: 0, reason: '未配置 API Key' };

  if (budgetExhausted(cfg)) {
    log.warn('每日 token 预算已耗尽，本轮跳过模型调用');
    return { ok: false, text: '', tokens: 0, reason: 'budget-exhausted' };
  }

  fs.mkdirSync(SANDBOX, { recursive: true });

  const allowed = [];
  const denied = [];

  const configuredModel = String(cfg.model?.name ?? '').trim();
  if (configuredModel && configuredModel !== LOCKED_MODEL) {
    log.warn(`配置里的模型「${configuredModel}」被忽略，强制使用 ${LOCKED_MODEL}`);
  }

  const options = {
    model: LOCKED_MODEL,
    effort: cfg.model?.effort || 'high',
    cwd: SANDBOX,
    permissionMode: 'default',
    maxTurns: Math.max(1, Number(cfg.limits?.maxTurnsPerRound) || 4),
    settingSources: [],
    tools: [],
    disallowedTools: DISALLOWED_TOOLS,
    systemPrompt: system,
    canUseTool: async (toolName, input) => {
      if (String(toolName).startsWith(SELF_TOOL_PREFIX)) {
        allowed.push(toolName);
        return { behavior: 'allow', updatedInput: input };
      }
      denied.push(toolName);
      log.warn(`拦截工具调用：${toolName}`);
      return { behavior: 'deny', message: `工具 ${toolName} 在本会话不可用`, interrupt: true };
    },
    env: {
      CODEBUDDY_API_KEY: key,
      CODEBUDDY_INTERNET_ENVIRONMENT: process.env.CODEBUDDY_INTERNET_ENVIRONMENT || 'internal'
    }
  };
  // 只挂我们自己的进程内 MCP（目前仅 web_search）。关掉搜索就整个不挂，
  // 模型连工具定义都看不到，也就不存在"被诱导去搜"的可能。
  if (cfg.search?.enabled !== false) {
    options.mcpServers = { [MCP_SERVER_NAME]: qqToolServer };
  }

  let text = '';
  let tokens = 0;
  let sawResult = false;

  try {
    const q = query({ prompt: user, options });
    for await (const message of q) {
      if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') {
            text += block.text;
            onText?.(block.text);
          }
        }
      }
      if (message.type === 'result') {
        sawResult = true;
        const u = message.usage ?? {};
        tokens = Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0);
        if (message.subtype && message.subtype !== 'success') {
          log.warn(`回合结束但 subtype=${message.subtype}`);
        }
      }
    }
  } catch (error) {
    log.error(`SDK 调用失败：${error?.message ?? error}`);
    return { ok: false, text: '', tokens: 0, reason: 'sdk-error' };
  }

  if (tokens > 0) {
    const usage = readUsage();
    usage.tokens += tokens;
    usage.rounds += 1;
    writeUsage(usage);
  }

  log.info(`回合完成 文本=${text.length}字 用量=${tokens} 来源=${source} 工具放行=${allowed.length} 拦截=${denied.length}`);
  return { ok: sawResult, text, tokens, reason: sawResult ? undefined : 'no-result' };
}
