/**
 * 取消注册表：运行器执行任务时登记 AbortController，取消路由通过它发出协作式取消信号。
 * 单进程内存语义（与 eventBus 一致）：进程重启后无控制器，
 * 取消路由对 running 孤儿任务直接落终态，不依赖注册表存活。
 */

const controllers = new Map<string, AbortController>();

export function registerCancel(taskId: string, controller: AbortController): void {
  controllers.set(taskId, controller);
}

export function unregisterCancel(taskId: string): void {
  controllers.delete(taskId);
}

export function getCancelController(taskId: string): AbortController | undefined {
  return controllers.get(taskId);
}
