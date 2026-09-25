import type { ToolResult } from 'contracts';
import { evaluateExpression } from '../tools';

/**
 * 模型适配层：nextStep 是唯一接口 —— 运行器根据返回的 ModelAction 推进任务。
 * demo 模型为确定性纯函数（相同 prompt 产生相同事件序列），P3 在此接口上接入真实模型。
 */

/** 供应商单次响应返回的 token 用量；demo 模型无此信息 */
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 单个工具调用：一次模型响应可能并行返回多个 */
export interface ModelToolCall {
  name: string;
  input: Record<string, unknown>;
}

export type ModelAction =
  | { kind: 'output'; text: string; usage?: ModelUsage }
  | {
      kind: 'tool_call';
      /** 本轮返回的全部工具调用（运行器逐个执行，结果按序回传） */
      calls: ModelToolCall[];
      usage?: ModelUsage;
      /** 推理模式返回的思维链：带工具调用的轮次必须在后续请求中传回（DeepSeek 要求，缺失返回 400） */
      reasoning?: string;
    }
  | { kind: 'finish'; summary: string; usage?: ModelUsage };

/** 已执行步骤的记录：模型据此决定下一步；toolResults 仅在 tool_call 后存在，与 calls 一一对应 */
export interface StepRecord {
  action: ModelAction;
  toolResults?: ToolResult[];
}

export interface ModelAdapter {
  /**
   * 根据任务 prompt 与已执行历史决定下一步。
   * 实现必须保证可终止（最终返回 finish）或由运行器步数上限兜底。
   * signal：任务取消信号；长时间操作（如真实模型的 HTTP 调用）应及时中止。
   * modelId：任务创建时选定的模型（受控目录 id）；demo 模型忽略，live 模型据此选模型。
   */
  nextStep(
    prompt: string,
    history: readonly StepRecord[],
    signal?: AbortSignal,
    modelId?: string,
  ): Promise<ModelAction>;
}

/** 从 prompt 中提取可求值的算术表达式片段；找不到或不可求值返回 null */
export function extractArithmeticExpression(prompt: string): string | null {
  const candidates = (prompt.match(/[0-9+\-*/().% \t]+/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => /[0-9]/.test(s) && /[+\-*/%]/.test(s))
    .sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    // 预先用与工具相同的求值器验证，保证 demo 只调用能成功的工具
    if (evaluateExpression(candidate).ok) return candidate;
  }
  return null;
}

/**
 * DemoModel：确定性模拟。
 * 固定流程（4 步）：开场输出 → 工具调用（表达式则 calculate，否则 text_stats）
 * → 结果描述输出 → finish 总结。相同 prompt 产生完全相同的事件序列。
 * stepDelayMs 模拟模型思考节奏（默认 400ms），让执行过程在实时流中可见；
 * 置 0 用于测试。
 */
export class DemoModel implements ModelAdapter {
  constructor(private readonly stepDelayMs = 400) {}

  async nextStep(prompt: string, history: readonly StepRecord[]): Promise<ModelAction> {
    if (this.stepDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.stepDelayMs));
    }
    const outputs = history.filter((h) => h.action.kind === 'output').length;
    const toolCalls = history.filter((h) => h.action.kind === 'tool_call').length;

    // 第 1 步：开场
    if (outputs === 0 && toolCalls === 0) {
      const brief = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
      return { kind: 'output', text: `收到任务，开始分析：${brief}` };
    }

    // 第 2 步：选择工具（决策只依赖 prompt，可复现）
    if (outputs === 1 && toolCalls === 0) {
      const expression = extractArithmeticExpression(prompt);
      if (expression) {
        return { kind: 'tool_call', calls: [{ name: 'calculate', input: { expression } }] };
      }
      return { kind: 'tool_call', calls: [{ name: 'text_stats', input: { text: prompt } }] };
    }

    // 第 3 步：描述工具结果
    if (toolCalls === 1 && outputs === 1) {
      const call = history[history.length - 1]!;
      if (call.action.kind === 'tool_call') {
        const result = call.toolResults?.[0];
        const first = call.action.calls[0]!;
        if (!result || !result.ok) {
          return { kind: 'output', text: `工具调用失败（${result?.error ?? '未知错误'}），任务无法继续计算。` };
        }
        if (first.name === 'calculate') {
          return { kind: 'output', text: `表达式计算结果：${String((first.input as { expression: string }).expression)} = ${String(result.data)}` };
        }
        const data = result.data as { characters: number; words: number; lines: number };
        return { kind: 'output', text: `文本统计完成：共 ${data.characters} 字符 / ${data.words} 词 / ${data.lines} 行。` };
      }
    }

    // 第 4 步：总结
    const call = history.find((h) => h.action.kind === 'tool_call');
    if (call && call.toolResults?.[0]?.ok && call.action.kind === 'tool_call') {
      const first = call.action.calls[0]!;
      const result = call.toolResults[0]!;
      if (first.name === 'calculate') {
        return { kind: 'finish', summary: `计算完成：${String((first.input as { expression: string }).expression)} = ${String(result.data)}` };
      }
      const data = result.data as { characters: number; words: number; lines: number };
      return { kind: 'finish', summary: `文本分析完成：共 ${data.characters} 字符、${data.words} 词、${data.lines} 行。` };
    }
    return { kind: 'finish', summary: '任务处理结束（工具调用未成功）。' };
  }
}
