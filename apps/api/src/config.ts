import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  apiPort: number;
  /** SQLite 数据库文件路径（相对 .env 时以仓库根目录解析） */
  databaseUrl: string;
  /** 模型提供方；空字符串表示仅演示模式 */
  modelProvider: string;
  modelApiKey: string | undefined;
  /** 真实模型 API 根地址（OpenAI 兼容 chat completions） */
  modelBaseUrl: string;
  /** 真实模型名（如 deepseek-flash）；仅作任务未指定模型时的回退值 */
  modelName: string;
  maxSteps: number;
  /** 单轮模型响应允许执行的工具调用数量上限（maxSteps 只计模型轮次；超限调用记为失败结果回传） */
  maxToolCallsPerTurn: number;
  stepTimeoutMs: number;
  // ===== P5 额度与限额（仅约束登录用户；匿名仅可 demo，live 已被 401 拦截） =====
  /** 每用户并发任务上限（queued + running 计数） */
  maxUserConcurrentTasks: number;
  /** 每用户每分钟创建任务数上限（滚动 60s 窗口，DB 计数） */
  userCreateRatePerMinute: number;
  /** 单任务预估费用上限（元）：预估超过该值的 live 任务拒绝创建 */
  maxTaskBudgetCny: number;
  /** demo 模型每步之间的固定延迟：让执行过程在 SSE 实时流中可见；0 表示立即执行 */
  demoStepDelayMs: number;
  /** Fastify 日志开关（测试时关闭避免噪音） */
  logger: boolean;
}

/** 本包根目录：apps/api */
const pkgRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
/** 仓库根目录 */
const repoRoot = path.resolve(pkgRoot, '..', '..');

/** 解析 .env 文件（不存在则忽略）；不覆盖已有环境变量 */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** 读取整数环境变量；非法值（NaN）回退默认值 */
function intEnv(key: string, fallback: number): number {
  return Number(process.env[key] ?? fallback) || fallback;
}

/** 读取浮点环境变量；非法值或负数回退默认值 */
function floatEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 读取字符串环境变量；空白视为未设置，回退默认值 */
function stringEnv(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  return value ? value : fallback;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  // 配置文件固定从仓库根目录读取，与命令执行位置无关
  loadEnvFile(path.join(repoRoot, '.env'));
  const databaseUrl = process.env.DATABASE_URL
    ? path.resolve(repoRoot, process.env.DATABASE_URL)
    : path.join(pkgRoot, 'data', 'workbench.db');
  return {
    apiPort: intEnv('API_PORT', 3000),
    databaseUrl,
    modelProvider: process.env.MODEL_PROVIDER ?? '',
    modelApiKey: process.env.MODEL_API_KEY,
    modelBaseUrl: stringEnv('MODEL_BASE_URL', 'https://api.deepseek.com'),
    modelName: stringEnv('MODEL_NAME', 'deepseek-flash'),
    maxSteps: intEnv('MAX_STEPS', 20),
    maxToolCallsPerTurn: intEnv('MAX_TOOL_CALLS_PER_TURN', 10),
    stepTimeoutMs: intEnv('STEP_TIMEOUT_MS', 60_000),
    maxUserConcurrentTasks: intEnv('MAX_USER_CONCURRENT_TASKS', 5),
    userCreateRatePerMinute: intEnv('USER_CREATE_RATE_PER_MINUTE', 10),
    maxTaskBudgetCny: floatEnv('MAX_TASK_BUDGET_CNY', 10),
    demoStepDelayMs: intEnv('DEMO_STEP_DELAY_MS', 400),
    logger: true,
    ...overrides,
  };
}
