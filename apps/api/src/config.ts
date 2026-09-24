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
  maxSteps: number;
  stepTimeoutMs: number;
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
    maxSteps: intEnv('MAX_STEPS', 20),
    stepTimeoutMs: intEnv('STEP_TIMEOUT_MS', 60_000),
    demoStepDelayMs: intEnv('DEMO_STEP_DELAY_MS', 400),
    logger: true,
    ...overrides,
  };
}
