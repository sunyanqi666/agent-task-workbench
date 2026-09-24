import { useEffect, useState } from 'react';
import type { Task } from 'contracts';
import { fetchTasks } from '../api';
import { StatusBadge } from './StatusBadge';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 任务列表：挂载与每 5 秒轮询；点击进入详情时间线 */
export function TaskList({ onOpen }: { onOpen: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const page = await fetchTasks(20);
        if (!cancelled) {
          setTasks(page.items);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      }
    };
    void load();
    const timer = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="card">
      <h2>任务列表{tasks !== null && <span className="count">（{tasks.length}）</span>}</h2>
      {error && <p className="form-error">{error}</p>}
      {tasks === null && !error && <p className="empty">加载中…</p>}
      {tasks !== null && tasks.length === 0 && (
        <p className="empty">还没有任务，从上方创建第一个吧。</p>
      )}
      {tasks !== null && tasks.length > 0 && (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <button type="button" className="task-item" onClick={() => onOpen(task.id)}>
                <span className="task-title">{task.prompt}</span>
                <span className="task-meta">
                  <StatusBadge status={task.status} />
                  <span className="task-time">{formatTime(task.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
