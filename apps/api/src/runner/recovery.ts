import { listUnfinishedTasks, transitionTask } from '../services/taskService';
import { runTask, type RunnerDeps } from './runTask';

/**
 * 启动恢复：运行器循环与取消注册表都在进程内存中，进程中断后重启，
 * 数据库里可能遗留停在 queued / running 的任务。启动时识别并处理，
 * 保证任何任务都不会永久停留在进行中状态：
 * - running：执行循环已随进程丢失，无法续跑 → 落终态 failed（interrupted，可重试）；
 * - queued：从未开始执行 → 直接重新入队执行（runTask 的幂等保护与异常兜底仍然生效）。
 */

export interface RecoveryResult {
  /** 重新入队执行的任务 id */
  resumed: string[];
  /** 标记为失败（interrupted）的任务 id */
  interrupted: string[];
}

export function recoverInterruptedTasks(deps: RunnerDeps): RecoveryResult {
  const result: RecoveryResult = { resumed: [], interrupted: [] };
  for (const { id, status } of listUnfinishedTasks(deps.db)) {
    if (status === 'running') {
      transitionInterrupted(deps, id);
      result.interrupted.push(id);
      continue;
    }
    void runTask(deps, id); // 异步恢复执行，不阻塞启动
    result.resumed.push(id);
  }
  return result;
}

function transitionInterrupted(deps: RunnerDeps, taskId: string): void {
  try {
    transitionTask(deps.db, taskId, {
      to: 'failed',
      errorCode: 'interrupted',
      message: '服务重启导致执行中断，任务未完成（可重试）',
    });
  } catch {
    // 单个任务恢复失败不阻断启动（如并发下已被其他路径落终态）
  }
}
