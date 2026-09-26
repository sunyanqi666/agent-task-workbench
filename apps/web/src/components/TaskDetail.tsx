import { useEffect, useMemo, useState } from 'react';
import type { LedgerEntryInfo, Task, TaskEvent, TaskStatus } from 'contracts';
import { cancelTask, fetchTask, fetchTaskEvents, fetchTaskLedger, retryTask, streamTaskEvents } from '../api';
import { StatusBadge } from './StatusBadge';
import { EventTimeline } from './EventTimeline';

/**
 * 任务详情：先全量回放持久化事件（刷新 / 断线后数据一致的来源），
 * 任务未终态时再从最大 seq 续接 SSE 实时流；事件按 seq 幂等合并，
 * EventSource 自动重连导致的重复投递会被直接忽略。
 * P5：终态后展示扣费明细（账本条目），并通知上层刷新余额（结算释放预留）。
 */

const TERMINAL_STATUS = new Set<TaskStatus>(['completed', 'failed', 'canceled']);

const LEDGER_KIND_LABEL: Record<LedgerEntryInfo['kind'], string> = {
  reserve: '预算预留',
  actual: '实际扣费',
  settle: '释放预留',
  topup: '充值',
  refund: '退款',
};

/** 终态事件 → 任务状态映射（收到终态事件后无需再拉快照） */
function statusOfTerminalEvent(event: TaskEvent): TaskStatus {
  if (event.type === 'task.completed') return 'completed';
  if (event.type === 'task.failed') return 'failed';
  return 'canceled';
}

export function TaskDetail({
  id,
  onBack,
  onOpenTask,
  onSettled,
}: {
  id: string;
  onBack: () => void;
  onOpenTask: (id: string) => void;
  onSettled?: () => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<Map<number, TaskEvent>>(new Map());
  const [ledger, setLedger] = useState<LedgerEntryInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // 扣费明细：登录用户的任务才有账本条目（401/404 静默隐藏；demo 任务为空）
  useEffect(() => {
    let cancelled = false;
    fetchTaskLedger(id)
      .then(({ entries }) => {
        if (!cancelled) setLedger(entries);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleTerminal = () => {
    // 终态：结算释放预留 → 通知上层刷新余额；同时拉取最终扣费明细
    onSettled?.();
    fetchTaskLedger(id)
      .then(({ entries }) => setLedger(entries))
      .catch(() => undefined);
  };

  useEffect(() => {
    let cancelled = false;
    let closeStream: (() => void) | null = null;
    setActionError(null);
    setActionPending(false);

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
                // 终态后刷新快照：拿到最终用量与时间戳（usage 存任务行，不在事件里）
                void fetchTask(id)
                  .then((t) => {
                    if (!cancelled) setTask(t);
                  })
                  .catch(() => undefined);
                handleTerminal(); // 结算释放预留 → 刷新余额与扣费明细
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

  const handleCancel = async (): Promise<void> => {
    if (!task || actionPending) return;
    setActionError(null);
    setActionPending(true);
    try {
      const updated = await cancelTask(task.id);
      // queued：立即 canceled；running：受理时仍 running，终态由 SSE 事件流推送
      setTask(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '取消失败');
    } finally {
      setActionPending(false);
    }
  };

  const handleRetry = async (): Promise<void> => {
    if (!task || actionPending) return;
    setActionError(null);
    setActionPending(true);
    try {
      const retry = await retryTask(task.id);
      onOpenTask(retry.id); // 跳转到重试生成的新任务
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '重试失败');
    } finally {
      setActionPending(false);
    }
  };

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
            <span>模型：{task.modelId}</span>
            {task.priceVersion !== null && <span>价格版本：{task.priceVersion}</span>}
            {(task.usage.promptTokens > 0 || task.usage.completionTokens > 0) && (
              <span>
                用量：输入 {task.usage.promptTokens} / 输出 {task.usage.completionTokens} tokens
              </span>
            )}
            <span>创建：{new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
            {running && <span className="live-indicator">实时接收事件中…</span>}
          </div>
          <div className="detail-actions">
            {(task.status === 'queued' || task.status === 'running') && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleCancel()}
                disabled={actionPending}
              >
                取消任务
              </button>
            )}
            {(task.status === 'failed' || task.status === 'canceled') && (
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleRetry()}
                disabled={actionPending}
              >
                重试此任务
              </button>
            )}
          </div>
          {actionError && <p className="form-error">{actionError}</p>}
          {ledger !== null && ledger.length > 0 && (
            <div className="ledger-box">
              <h3>扣费明细</h3>
              <ul className="ledger-list">
                {ledger.map((entry) => (
                  <li key={entry.id}>
                    <span className={`ledger-kind ledger-kind-${entry.kind}`}>
                      {LEDGER_KIND_LABEL[entry.kind]}
                    </span>
                    <span className={entry.amountCny >= 0 ? 'ledger-in' : 'ledger-out'}>
                      {entry.amountCny >= 0 ? '+' : '−'}¥{Math.abs(entry.amountCny).toFixed(4)}
                    </span>
                    {entry.memo && <span className="ledger-memo">{entry.memo}</span>}
                    <span className="ledger-time">
                      {new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="hint">最终以供应商实际用量按记账时价格版本结算；重复回调不重复入账</p>
            </div>
          )}
          <div className="timeline-wrap">
            <EventTimeline events={ordered} />
          </div>
        </>
      )}
    </section>
  );
}
