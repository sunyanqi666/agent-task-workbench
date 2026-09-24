import type { DatabaseSync } from 'node:sqlite';
import type { TaskEventPayloads } from 'contracts';
import type { ToolRegistry } from '../tools';
import { validateToolInput } from '../tools';
import { appendEvent, getTask, transitionTask } from '../services/taskService';
import type { ModelAction, ModelAdapter, StepRecord } from './model';

/**
 * 任务运行器：驱动 状态机 + 模型 + 工具循环。
 * 每步产生的 model.output / tool.* 事件逐条持久化；状态迁移（含对应事件）由任务服务保证同事务。
 * 步数与单步超时上限是安全边界，超出即任务失败。
 */

export interface RunnerDeps {
  db: DatabaseSync;
  registry: ToolRegistry;
  model: ModelAdapter;
  maxSteps: number;
  stepTimeoutMs: number;
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
  const { db, model, maxSteps } = deps;
  try {
    const task = getTask(db, taskId);
    if (task.status !== 'queued') return;
    transitionTask(db, taskId, { to: 'running' });

    const history: StepRecord[] = [];
    for (let step = 0; step < maxSteps; step++) {
      let action: ModelAction;
      try {
        action = await model.nextStep(task.prompt, history);
      } catch (err) {
        transitionTask(db, taskId, {
          to: 'failed',
          errorCode: 'model_error',
          message: `模型调用失败：${errorMessage(err)}`,
        });
        return;
      }

      if (action.kind === 'output') {
        history.push({ action });
        appendEvent(db, taskId, 'model.output', { text: action.text });
        continue;
      }

      if (action.kind === 'tool_call') {
        const record: StepRecord = { action };
        history.push(record);
        appendEvent(db, taskId, 'tool.started', {
          name: action.name,
          input: action.input,
        });
        await executeToolCall(deps, taskId, record);
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
  }
}

/** 执行单次工具调用：白名单校验 → 输入校验 → 超时受限执行；结果写入 tool.completed / tool.failed 事件 */
async function executeToolCall(deps: RunnerDeps, taskId: string, record: StepRecord): Promise<void> {
  const { db, registry, stepTimeoutMs } = deps;
  const action = record.action;
  if (action.kind !== 'tool_call') return;

  const tool = registry.get(action.name);
  const violation = tool ? validateToolInput(tool, action.input) : `工具未注册：${action.name}（白名单约束）`;

  if (violation) {
    record.toolResult = { ok: false, error: violation };
    appendEvent(db, taskId, 'tool.failed', { name: action.name, error: violation });
    return;
  }

  const startedAt = Date.now();
  try {
    const signal = AbortSignal.timeout(stepTimeoutMs);
    const result = await tool!.execute(action.input, { taskId, signal });
    const durationMs = Date.now() - startedAt;
    record.toolResult = result;
    if (result.ok) {
      const payload: TaskEventPayloads['tool.completed'] = {
        name: action.name,
        output: result.data,
        durationMs,
      };
      appendEvent(db, taskId, 'tool.completed', payload);
    } else {
      appendEvent(db, taskId, 'tool.failed', {
        name: action.name,
        error: result.error ?? '未知错误',
      });
    }
  } catch (err) {
    const message = isTimeoutAbort(err)
      ? `工具执行超时（>${stepTimeoutMs}ms）`
      : `工具执行异常：${errorMessage(err)}`;
    record.toolResult = { ok: false, error: message };
    appendEvent(db, taskId, 'tool.failed', { name: action.name, error: message });
  }
}
