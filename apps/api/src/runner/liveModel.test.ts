import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultToolRegistry } from '../tools';
import type { StepRecord } from './model';
import { LiveModel } from './liveModel';

/** 脚本化 fetch：记录每次请求（URL / 请求体 / 头），按序返回预设响应 */
function scriptedFetch(
  responses: { status?: number; body: unknown }[],
): {
  impl: typeof fetch;
  calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[];
} {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let index = 0;
  const impl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const scripted = responses[Math.min(index++, responses.length - 1)]!;
    return new Response(JSON.stringify(scripted.body), { status: scripted.status ?? 200 });
  };
  return { impl, calls };
}

function makeModel(impl: typeof fetch): LiveModel {
  return new LiveModel({
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.com',
    modelName: 'deepseek-chat',
    registry: createDefaultToolRegistry(),
    timeoutMs: 5000,
    fetchImpl: impl,
  });
}

test('LiveModel：tool_calls 响应 → tool_call 动作；请求含模型名 / 工具声明 / 鉴权头', async () => {
  const { impl, calls } = scriptedFetch([
    {
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { name: 'calculate', arguments: '{"expression":"(1+2)*3"}' } }],
            },
          },
        ],
      },
    },
  ]);
  const action = await makeModel(impl).nextStep('计算 (1+2)*3', []);
  assert.deepEqual(action, { kind: 'tool_call', name: 'calculate', input: { expression: '(1+2)*3' } });

  const call = calls[0]!;
  assert.equal(call.url, 'https://api.example.com/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer sk-test'); // 密钥只进请求头，不进事件与日志
  assert.equal(call.body.model, 'deepseek-chat');
  const tools = call.body.tools as { type: string; function: { name: string } }[];
  assert.ok(tools.some((t) => t.type === 'function' && t.function.name === 'calculate'));
  assert.ok(tools.some((t) => t.function.name === 'text_stats'));
  const messages = call.body.messages as { role: string; content: string }[];
  assert.equal(messages[0]!.role, 'system');
  assert.deepEqual(messages[1], { role: 'user', content: '计算 (1+2)*3' });
});

test('LiveModel：无工具调用的文本响应 → finish（文本即最终总结）', async () => {
  const { impl } = scriptedFetch([
    { body: { choices: [{ message: { content: '任务完成：结果是 6' } }] } },
  ]);
  const action = await makeModel(impl).nextStep('x', []);
  assert.deepEqual(action, { kind: 'finish', summary: '任务完成：结果是 6' });
});

test('LiveModel：历史重建 —— assistant 工具调用与 tool 结果消息成对（id 一致）', async () => {
  const { impl, calls } = scriptedFetch([
    { body: { choices: [{ message: { content: '完成' } }] } },
  ]);
  const history: StepRecord[] = [
    {
      action: { kind: 'tool_call', name: 'calculate', input: { expression: '1+2' } },
      toolResult: { ok: true, data: 3 },
    },
  ];
  await makeModel(impl).nextStep('计算 1+2', history);
  const messages = calls[0]!.body.messages as Array<{
    role: string;
    content: string | null;
    tool_calls?: { id: string }[];
    tool_call_id?: string;
  }>;
  const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls);
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.ok(assistant, '应有携带 tool_calls 的 assistant 消息');
  assert.ok(toolMsg, '应有 tool 结果消息');
  assert.equal(assistant.tool_calls![0]!.id, toolMsg.tool_call_id);
  assert.ok(String(toolMsg.content).includes('"data":3'));
});

test('LiveModel：非法参数 / 空响应 / HTTP 错误 → 抛错（运行器转 model_error）', async () => {
  const badJson = scriptedFetch([
    {
      body: {
        choices: [
          { message: { content: null, tool_calls: [{ function: { name: 'calculate', arguments: '{oops' } }] } },
        ],
      },
    },
  ]);
  await assert.rejects(makeModel(badJson.impl).nextStep('x', []), /合法 JSON/);

  const empty = scriptedFetch([{ body: { choices: [{ message: { content: null } }] } }]);
  await assert.rejects(makeModel(empty.impl).nextStep('x', []), /无工具调用也无文本/);

  const httpError = scriptedFetch([{ status: 401, body: { error: 'invalid key' } }]);
  await assert.rejects(makeModel(httpError.impl).nextStep('x', []), /401/);
});
