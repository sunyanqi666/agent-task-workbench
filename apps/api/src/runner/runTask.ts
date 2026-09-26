import type { DatabaseSync } from 'node:sqlite';
import type { TaskEventPayloads, ToolResult } from 'contracts';
import type { ToolRegistry } from '../tools';
import { validateToolInput } from '../tools';
import { appendEvent, getTask, recordModelUsage, transitionTask } from '../services/taskService';
import type { ModelAction, ModelAdapter, ModelToolCall, StepRecord } from './model';
import { registerCancel, unregisterCancel } from './cancelRegistry';

/**
 * 任务运行器：驱动 状态机 + 模型 + 工具循环。
 * 每步产生的 model.output / tool.* 事件逐条持久化；状态迁移（含对应事件）由任务服务保证同事务。
 * 步数与单步超时上限是安全边界，超出即任务失败。
 * 取消为协作式：路由经注册表触发 AbortController，运行器在步间 / 模型调用 / 工具执行处响应。
 */

export interface RunnerDeps {
  db: DatabaseSync;
  registry: ToolRegistry;
  /** demo 模型（确定性模拟） */
  model: ModelAdapter;
  /** live 模型（真实服务）；未配置为 null，创建与重试入口应先行校验 */
  liveModel: ModelAdapter | null;
  maxSteps: number;
  /** 单轮模型响应允许执行的工具调用数量上限（超限调用不执行，记为失败结果回传） */
  maxToolCallsPerTurn: number;
  stepTimeoutMs: number;
  // P5 额度与限额：创建 / 重试入口的路由层校验使用（运行器本身不消费）
  maxUserConcurrentTasks: number;
  userCreateRatePerMinute: number;
  maxTaskBudgetCny: number;
}

/** 协作式取消的内部信号：工具执行中途被取消时跳过事件写入，由运行器统一转终态 */
export class TaskCanceledError extends Error {
  constructor() {
    super('任务已被取消');
    this.name = 'TaskCanceledError';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * 执行一个任务直至终态。仅处理 queued 状态的任务（幂等保护）；
 * 任何异常都不会向外抛出 —— 运行器通过事件与终态记录一切。
 */
export async function runTask(deps: RunnerDeps, taskId: string): Promise<void> {
  const { db, maxSteps } = deps;
  const controller = new AbortController();
  registerCancel(taskId, controller); // 先登记再迁移：取消路由在本窗口到达时能拿到控制器
  try {
    const task = getTask(db, taskId);
    if (task.status !== 'queued') return;
    transitionTask(db, taskId, { to: 'running' });

    const model = task.mode === 'live' ? deps.liveModel : deps.model;
    if (!model) {
      transitionTask(db, taskId, {
        to: 'failed',
        errorCode: 'model_error',
        message: 'live 任务无法执行：服务端未配置真实模型（MODEL_PROVIDER / MODEL_API_KEY）',
      });
      return;
    }

    const history: StepRecord[] = [];
    for (let step = 0; step < maxSteps; step++) {
      // 步间取消检查：信号触发，或任务已被外部直接落终态（无控制器的窗口）
      if (controller.signal.aborted) {
        transitionTask(db, taskId, { to: 'canceled' });
        return;
      }
      if (getTask(db, taskId).status !== 'running') return;

      let action: ModelAction;
      try {
        action = await model.nextStep(task.prompt, history, controller.signal, task.modelId);
      } catch (err) {
        if (controller.signal.aborted) {
          transitionTask(db, taskId, { to: 'canceled' });
          return;
        }
        transitionTask(db, taskId, {
          to: 'failed',
          errorCode: 'model_error',
          message: `模型调用失败：${errorMessage(err)}`,
        });
        return;
    }
      // 供应商返回的用量：真实发生的成本，取消前的响应也计入任务行
      if (action.usage) recordModelUsage(db, taskId, action.usage);
      if (controller.signal.aborted) {
        // 模型返回后、写事件前被取消：事件不落库，直接转终态
        transitionTask(db, taskId, { to: 'canceled' });
        return;
      }

      if (action.kind === 'output') {
        history.push({ action });
        appendEvent(db, taskId, 'model.output', { text: action.text });
        continue;
      }

      if (action.kind === 'tool_call') {
        // 一轮可能包含多个工具调用：逐个执行，每个调用产生 started + completed/failed 事件，
        // 结果按序写入历史与该轮动作的 calls 一一对应（回传给模型时成对）。
        // 单轮调用数受 maxToolCallsPerTurn 约束（maxSteps 只计模型轮次）：超限调用不执行，
        // 记为失败结果回传（与未注册工具同为无 started 的 tool.failed），模型可据此容错。
        const toolResults: ToolResult[] = [];
        const record: StepRecord = { action, toolResults };
        history.push(record);
        try {
          for (const [callIndex, call] of action.calls.entries()) {
            if (controller.signal.aborted) break; // 轮内取消：停止剩余调用，由步间检查统一转终态
            if (callIndex >= deps.maxToolCallsPerTurn) {
              const error = `超过单轮工具调用数量上限（${deps.maxToolCallsPerTurn}），本调用未执行`;
              appendEvent(db, taskId, 'tool.failed', { name: call.name, error });
              toolResults.push({ ok: false, error });
              continue;
            }
            appendEvent(db, taskId, 'tool.started', { name: call.name, input: call.input });
            toolResults.push(await executeToolCall(deps, taskId, call, controller.signal));
          }
        } catch (err) {
          if (err instanceof TaskCanceledError) {
            transitionTask(db, taskId, { to: 'canceled' });
            return;
          }
          throw err;
        }
        continue;
      }

      transitionTask(db, taskId, { to: 'completed', summary: action.summary });
      return;
    }

    // 循环耗尽步数预算
    transitionTask(db, taskId, {
      to: 'failed',
      errorCode: 'max_steps_exceeded',
      message: `超过步数上限（${maxSteps}）`,
    });
  } catch (err) {
    // 兜底：确保任务不会永远停在 running（若已终态则忽略）
    try {
      const task = getTask(db, taskId);
      if (task.status === 'queued' || task.status === 'running') {
        transitionTask(db, taskId, {
          to: 'failed',
          errorCode: 'internal',
          message: `运行器内部错误：${errorMessage(err)}`,
        });
      }
    } catch {
      // 记录终态失败本身失败时不再向外抛出
    }
  } finally {
    unregisterCancel(taskId);
  }
}

/**
 * 执行单个工具调用：白名单校验 → 输入校验 → 超时与取消双信号受限执行；
 * 结果写入 tool.completed / tool.failed 事件并返回；执行中途被取消则抛 TaskCanceledError（不写结果事件）
 */
async function executeToolCall(
  deps: RunnerDeps,
  taskId: string,
  call: ModelToolCall,
  cancelSignal: AbortSignal,
): Promise<ToolResult> {
  const { db, registry, stepTimeoutMs } = deps;

  const tool = registry.get(call.name);
  const violation = tool ? validateToolInput(tool, call.input) : `工具未注册：${call.name}（白名单约束）`;

  if (violation) {
    appendEvent(db, taskId, 'tool.failed', { name: call.name, error: violation });
    return { ok: false, error: violation };
  }

  const startedAt = Date.now();
  try {
    // 超时与取消信号合并：任一触发即中止工具执行
    const signal = AbortSignal.any([AbortSignal.timeout(stepTimeoutMs), cancelSignal]);
    const result = await tool!.execute(call.input, { taskId, signal });
    if (cancelSignal.aborted) throw new TaskCanceledError(); // 执行中被取消：结果不落事件
    const durationMs = Date.now() - startedAt;
    if (result.ok) {
      const payload: TaskEventPayloads['tool.completed'] = {
        name: call.name,
        output: result.data,
        durationMs,
      };
      appendEvent(db, taskId, 'tool.completed', payload);
    } else {
      appendEvent(db, taskId, 'tool.failed', {
        name: call.name,
        error: result.error ?? '未知错误',
      });
    }
    return result;
  } catch (err) {
    if (cancelSignal.aborted || err instanceof TaskCanceledError) {
      throw new TaskCanceledError();
    }
    const message = isTimeoutAbort(err)
      ? `工具执行超时（>${stepTimeoutMs}ms）`
      : `工具执行异常：${errorMessage(err)}`;
    appendEvent(db, taskId, 'tool.failed', { name: call.name, error: message });
    return { ok: false, error: message };
  }
}
