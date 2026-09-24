import type { ToolDefinition } from 'contracts';

/**
 * 工具注册表：运行器只允许调用已注册工具（白名单）。
 * 注册时校验定义合法性；执行前校验输入（见 validateToolInput）。
 */

/** 输入校验失败信息；null 表示通过 */
export type InputViolation = string | null;

const MAX_STRING_LENGTH = 10_000; // 工具输入字符串上限（安全边界）

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /** 泛型接收具体工具；存储侧统一为默认类型（TS 方差限制，需一次断言收敛） */
  register<I>(def: ToolDefinition<I>): void {
    if (!def.name || typeof def.name !== 'string') {
      throw new Error('工具名不能为空');
    }
    if (this.tools.has(def.name)) {
      throw new Error(`工具已注册：${def.name}`);
    }
    if (!def.inputSchema || def.inputSchema.type !== 'object') {
      throw new Error(`工具 ${def.name} 的 inputSchema 必须为 object 类型`);
    }
    this.tools.set(def.name, def as unknown as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
}

/**
 * 按工具的 inputSchema 校验输入：
 * - 必填项存在且类型匹配（契约声明的简化 JSON Schema）
 * - 拒绝未声明的属性（白名单原则，防注入未知参数）
 * - 字符串长度受上限约束
 * 返回 null 表示通过，否则返回中文错误信息。
 */
export function validateToolInput<I>(
  def: ToolDefinition<I>,
  input: unknown,
): InputViolation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return `工具 ${def.name} 的输入必须是对象`;
  }
  const provided = input as Record<string, unknown>;
  const { properties, required = [] } = def.inputSchema;

  for (const key of Object.keys(provided)) {
    if (!(key in properties)) {
      return `工具 ${def.name} 不接受未声明的参数：${key}`;
    }
  }
  for (const key of required) {
    if (!(key in provided) || provided[key] === undefined) {
      return `工具 ${def.name} 缺少必填参数：${key}`;
    }
  }
  for (const [key, value] of Object.entries(provided)) {
    const schema = properties[key];
    if (!schema) {
      return `工具 ${def.name} 缺少参数定义：${key}`;
    }
    if (value === undefined) continue; // 可选参数未传
    const expected = schema.type;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (actual !== expected) {
      return `工具 ${def.name} 的参数 ${key} 类型应为 ${expected}，实际为 ${actual}`;
    }
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      return `工具 ${def.name} 的参数 ${key} 超过长度上限（${MAX_STRING_LENGTH} 字符）`;
    }
  }
  return null;
}
