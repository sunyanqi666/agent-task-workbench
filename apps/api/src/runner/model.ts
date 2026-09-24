import type { ToolResult } from 'contracts';
import { evaluateExpression } from '../tools';

/**
 * 模型适配层：nextStep 是唯一接口 —— 运行器根据返回的 ModelAction 推进任务。
 * demo 模型为确定性纯函数（相同 prompt 产生相同事件序列），P3 在此接口上接入真实模型。
 */

export type ModelAction =
  | { kind: 'output'; text: string }
  | { kind: 'tool_call'; name: string; input: Record<string, unknown> }
  | { kind: 'finish'; summary: string };

/** 已执行步骤的记录：模型据此决定下一步；toolResult 仅在 tool_call 后存在 */
export interface StepRecord {
  action: ModelAction;
  toolResult?: ToolResult;
}

export interface ModelAdapter {
  /**
   * 根据任务 prompt 与已执行历史决定下一步。
   * 实现必须保证可终止（最终返回 finish）或由运行器步数上限兜底。
   */
  nextStep(prompt: string, history: readonly StepRecord[]): Promise<ModelAction>;
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
 */
export class DemoModel implements ModelAdapter {
  async nextStep(prompt: string, history: readonly StepRecord[]): Promise<ModelAction> {
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
        return { kind: 'tool_call', name: 'calculate', input: { expression } };
      }
      return { kind: 'tool_call', name: 'text_stats', input: { text: prompt } };
    }

    // 第 3 步：描述工具结果
    if (toolCalls === 1 && outputs === 1) {
      const call = history[history.length - 1]!;
      if (call.action.kind === 'tool_call') {
        const result = call.toolResult;
        if (!result || !result.ok) {
          return { kind: 'output', text: `工具调用失败（${result?.error ?? '未知错误'}），任务无法继续计算。` };
        }
        if (call.action.name === 'calculate') {
          return { kind: 'output', text: `表达式计算结果：${String((call.action.input as { expression: string }).expression)} = ${String(result.data)}` };
        }
        const data = result.data as { characters: number; words: number; lines: number };
        return { kind: 'output', text: `文本统计完成：共 ${data.characters} 字符 / ${data.words} 词 / ${data.lines} 行。` };
      }
    }

    // 第 4 步：总结
    const call = history.find((h) => h.action.kind === 'tool_call');
    if (call && call.toolResult?.ok && call.action.kind === 'tool_call') {
      if (call.action.name === 'calculate') {
        return { kind: 'finish', summary: `计算完成：${String((call.action.input as { expression: string }).expression)} = ${String(call.toolResult.data)}` };
      }
      const data = call.toolResult.data as { characters: number; words: number; lines: number };
      return { kind: 'finish', summary: `文本分析完成：共 ${data.characters} 字符、${data.words} 词、${data.lines} 行。` };
    }
    return { kind: 'finish', summary: '任务处理结束（工具调用未成功）。' };
  }
}
