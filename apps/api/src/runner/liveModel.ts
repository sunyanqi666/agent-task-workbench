import type { ToolRegistry } from '../tools';
import type { ModelAction, ModelAdapter, StepRecord } from './model';

/**
 * 真实模型适配器：DeepSeek（OpenAI 兼容 chat completions）。
 * 每次 nextStep = 一次补全请求：把任务 prompt 与已执行历史重建为消息序列，
 * 连同白名单工具声明一并发给模型；返回 tool_call（继续循环）或 finish（最终总结）。
 * 密钥仅存在服务端内存，不进入事件与日志。
 */

/** OpenAI 兼容消息结构（仅声明本适配器用到的字段） */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface LiveModelOptions {
  apiKey: string;
  /** API 根地址（如 https://api.deepseek.com） */
  baseUrl: string;
  /** 模型名（如 deepseek-chat） */
  modelName: string;
  registry: ToolRegistry;
  /** 单次模型调用超时（毫秒） */
  timeoutMs: number;
  /** 注入 fetch 便于测试；缺省使用全局 fetch */
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT =
  '你是任务执行助手。可以使用提供的工具完成任务：需要计算或统计时先调用工具，' +
  '得到结果后基于结果继续。任务完成时不要调用工具，直接输出简明的最终总结。';

export class LiveModel implements ModelAdapter {
  constructor(private readonly options: LiveModelOptions) {}

  async nextStep(
    prompt: string,
    history: readonly StepRecord[],
    signal?: AbortSignal,
    modelId?: string,
  ): Promise<ModelAction> {
    const { baseUrl, modelName, apiKey, registry, timeoutMs, fetchImpl } = this.options;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const callSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    const res = await (fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId ?? modelName, // 任务所选模型优先；未指定回退全局 MODEL_NAME
        messages: this.buildMessages(prompt, history),
        tools: registry.list().map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: 'auto',
        stream: false,
      }),
      signal: callSignal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`模型服务返回 ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('模型返回空响应');

    // 供应商返回的用量（缺字段按 0 记；仅在出现 usage 对象时附加，保持无用量动作的形状不变）
    const usage =
      data.usage &&
      (data.usage.prompt_tokens !== undefined || data.usage.completion_tokens !== undefined)
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined;

    const toolCall = message.tool_calls?.[0];
    if (toolCall) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        throw new Error(`模型工具调用参数不是合法 JSON：${toolCall.function.name}`);
      }
      return usage ? { kind: 'tool_call', name: toolCall.function.name, input, usage } : { kind: 'tool_call', name: toolCall.function.name, input };
    }
    if (message.content && message.content.trim()) {
      // 无工具调用的文本即最终答案（模型完成时不再调用工具）
      return usage
        ? { kind: 'finish', summary: message.content, usage }
        : { kind: 'finish', summary: message.content };
    }
    throw new Error('模型响应既无工具调用也无文本');
  }

  /**
   * 重建消息序列：system + user + 历史步骤。
   * tool_call 步骤展开为「assistant 声明调用 + tool 携带结果」两条消息，
   * id 成对且由序号确定性生成，满足 API 对消息配对的要求。
   */
  private buildMessages(prompt: string, history: readonly StepRecord[]): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ];
    history.forEach((record, index) => {
      const action = record.action;
      if (action.kind === 'output') {
        messages.push({ role: 'assistant', content: action.text });
        return;
      }
      if (action.kind !== 'tool_call') return; // finish 不会进入历史（运行器收到即终止），类型完备保护
      const callId = `call_${index}`;
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name: action.name, arguments: JSON.stringify(action.input) },
          },
        ],
      });
      messages.push({
        role: 'tool',
        content: JSON.stringify(record.toolResult ?? { ok: false, error: '结果缺失' }),
        tool_call_id: callId,
      });
    });
    return messages;
  }
}
