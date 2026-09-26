import type { ToolRegistry } from '../tools';
import type { ModelAction, ModelAdapter, ModelToolCall, StepRecord } from './model';

/**
 * 真实模型适配器：DeepSeek（OpenAI 兼容 chat completions）。
 * 每次 nextStep = 一次补全请求：把任务 prompt 与已执行历史重建为消息序列，
 * 连同白名单工具声明一并发给模型；返回 tool_call（继续循环）或 finish（最终总结）。
 * 密钥仅存在服务端内存，不进入事件与日志。
 */

/** OpenAI 兼容消息结构（仅声明本适配器用到的字段；reasoning_content 为 DeepSeek 扩展） */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      /** 推理模式输出的思维链（DeepSeek 扩展，与 content 同级） */
      reasoning_content?: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface LiveModelOptions {
  apiKey: string;
  /** API 根地址（如 https://api.deepseek.com） */
  baseUrl: string;
  /** 模型名（如 deepseek-flash）；仅作任务未指定 modelId 时的回退值 */
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

    // 思维链：带工具调用的轮次必须原样传回后续请求（DeepSeek 要求，缺失返回 400）；
    // 无工具调用轮次即使传回也会被忽略，故只随 tool_call 动作保存
    const reasoning = message.reasoning_content?.trim() || undefined;
    // 供应商返回的用量（缺字段按 0 记；仅在出现 usage 对象时附加，保持无用量动作的形状不变）
    const usage =
      data.usage &&
      (data.usage.prompt_tokens !== undefined || data.usage.completion_tokens !== undefined)
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
          }
        : undefined;
    const extras = {
      ...(usage ? { usage } : {}),
      ...(reasoning ? { reasoning } : {}),
    };

    // 一次响应可能返回多个工具调用：全部解析（任一参数非法即失败，避免部分执行）
    const parsedCalls: ModelToolCall[] = [];
    for (const raw of message.tool_calls ?? []) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(raw.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        throw new Error(`模型工具调用参数不是合法 JSON：${raw.function.name}`);
      }
      parsedCalls.push({ name: raw.function.name, input });
    }
    if (parsedCalls.length > 0) {
      return { kind: 'tool_call', calls: parsedCalls, ...extras };
    }
    if (message.content && message.content.trim()) {
      // 无工具调用的文本即最终答案（模型完成时不再调用工具）
      return { kind: 'finish', summary: message.content, ...extras };
    }
    throw new Error('模型响应既无工具调用也无文本');
  }

  /**
   * 重建消息序列：system + user + 历史步骤。
   * tool_call 步骤展开为「assistant 声明全部调用 + 每个调用一条 tool 结果消息」，
   * id 由记录序号 + 调用序号确定性生成并成对，满足 API 对消息配对的要求；
   * 该轮的思维链（reasoning_content）必须随 assistant 消息传回（DeepSeek 要求，缺失返回 400）。
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
      messages.push({
        role: 'assistant',
        content: null,
        // 思考模式要求 tool_call 轮次的 reasoning_content 必须回传（缺失 400）；
        // 响应偶发缺失该字段时传空字符串兜底（实测 DeepSeek 接受空串）
        reasoning_content: action.reasoning ?? '',
        tool_calls: action.calls.map((call, callIndex) => ({
          id: `call_${index}_${callIndex}`,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      });
      action.calls.forEach((_call, callIndex) => {
        const result = record.toolResults?.[callIndex];
        messages.push({
          role: 'tool',
          content: JSON.stringify(result ?? { ok: false, error: '结果缺失' }),
          tool_call_id: `call_${index}_${callIndex}`,
        });
      });
    });
    return messages;
  }
}
