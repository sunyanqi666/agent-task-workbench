import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskEvent, TaskStatus } from 'contracts';
import { fetchTask, fetchTaskEvents, streamTaskEvents } from '../api';
import { StatusBadge } from './StatusBadge';
import { EventTimeline } from './EventTimeline';

/**
 * 任务详情：先全量回放持久化事件（刷新 / 断线后数据一致的来源），
 * 任务未终态时再从最大 seq 续接 SSE 实时流；事件按 seq 幂等合并，
 * EventSource 自动重连导致的重复投递会被直接忽略。
 */

const TERMINAL_STATUS = new Set<TaskStatus>(['completed', 'failed', 'canceled']);

/** 终态事件 → 任务状态映射（收到终态事件后无需再拉快照） */
function statusOfTerminalEvent(event: TaskEvent): TaskStatus {
  if (event.type === 'task.completed') return 'completed';
  if (event.type === 'task.failed') return 'failed';
  return 'canceled';
}

export function TaskDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<Map<number, TaskEvent>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let closeStream: (() => void) | null = null;

    const load = async () => {
      try {
        // 1) 快照 + 全量回放：刷新后从这里恢复
        const [snapshot, replayed] = await Promise.all([fetchTask(id), fetchTaskEvents(id)]);
        if (cancelled) return;
        setTask(snapshot);
        setEvents(new Map(replayed.map((event) => [event.seq, event])));

        // 2) 未终态：从最大 seq 续接实时流
        if (!TERMINAL_STATUS.has(snapshot.status)) {
          closeStream = streamTaskEvents(
            id,
            replayed.at(-1)?.seq ?? 0,
            (event) => {
              if (cancelled) return;
              setEvents((prev) => {
                if (prev.has(event.seq)) return prev; // 重连重复投递：幂等忽略
                const next = new Map(prev);
                next.set(event.seq, event);
                return next;
              });
              if (
                event.type === 'task.completed' ||
                event.type === 'task.failed' ||
                event.type === 'task.canceled'
              ) {
                setTask((prev) =>
                  prev ? { ...prev, status: statusOfTerminalEvent(event) } : prev,
                );
                closeStream?.();
              }
            },
            () => {
              // 网络错误：浏览器自动重连；此处仅在连接失败时刷新一次快照兜底
              if (!cancelled) {
                void fetchTask(id).then((t) => {
                  if (!cancelled && TERMINAL_STATUS.has(t.status)) setTask(t);
                }).catch(() => undefined);
              }
            },
          );
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      }
    };

    void load();
    return () => {
      cancelled = true;
      closeStream?.();
    };
  }, [id]);

  const ordered = useMemo(
    () => [...events.values()].sort((a, b) => a.seq - b.seq),
    [events],
  );

  if (error) {
    return (
      <section className="card">
        <h2>任务详情</h2>
        <p className="form-error">{error}</p>
        <button type="button" className="link-button" onClick={onBack}>
          ← 返回任务列表
        </button>
      </section>
    );
  }

  const running = task !== null && task.status === 'running';

  return (
    <section className="card detail-card">
      <button type="button" className="link-button" onClick={onBack}>
        ← 返回任务列表
      </button>
      {task === null ? (
        <p className="empty">加载中…</p>
      ) : (
        <>
          <div className="detail-head">
            <h2 className="detail-prompt">{task.prompt}</h2>
            <StatusBadge status={task.status} />
          </div>
          <div className="detail-meta">
            <span>模式：{task.mode}</span>
            <span>创建：{new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
            {running && <span className="live-indicator">实时接收事件中…</span>}
          </div>
          <div className="timeline-wrap">
            <EventTimeline events={ordered} />
          </div>
        </>
      )}
    </section>
  );
}
