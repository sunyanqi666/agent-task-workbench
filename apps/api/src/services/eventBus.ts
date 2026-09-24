import { EventEmitter } from 'node:events';
import type { TaskEvent } from 'contracts';

/**
 * 进程内事件总线：SSE 实时流与持久化共用同一事件源。
 * taskService 在事务提交后 publish；stream 路由 subscribe。
 * 单进程架构下这就够用；多实例部署时需替换为 Redis 之类的广播通道。
 */

const bus = new EventEmitter();
bus.setMaxListeners(200);

/** 广播一条任务事件（仅在数据库事务提交成功后调用，保证订阅者可读到） */
export function publishTaskEvent(event: TaskEvent): void {
  bus.emit(`task:${event.taskId}`, event);
}

/** 订阅指定任务的事件；返回取消函数 */
export function subscribeTaskEvents(
  taskId: string,
  listener: (event: TaskEvent) => void,
): () => void {
  bus.on(`task:${taskId}`, listener);
  return () => {
    bus.off(`task:${taskId}`, listener);
  };
}
