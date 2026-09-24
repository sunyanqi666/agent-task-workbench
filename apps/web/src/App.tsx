import { useEffect, useState } from 'react';
import type { HealthInfo } from 'contracts';
import { fetchHealth } from './api';

export default function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const h = await fetchHealth();
        if (cancelled) return;
        setHealth(h);
        setDown(false);
      } catch {
        if (!cancelled) setDown(true);
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const badgeText = down
    ? 'API 未连接'
    : health === null
      ? '连接中…'
      : `API 正常 · v${health.version}`;

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Agent Task Workbench</h1>
          <p className="subtitle">可观察的 Agent 任务执行：创建 → 执行 → 工具调用 → 回放</p>
        </div>
        <div className={`badge ${down ? 'badge-down' : ''}`}>{badgeText}</div>
      </header>

      <main>
        <section className="card">
          <h2>说明</h2>
          <p className="empty">
            任务执行引擎已就绪：调用 <code>POST /api/v1/tasks</code> 创建任务，
            后端将执行模拟模型与受限工具调用，全部事件持久化到 SQLite，
            可通过 <code>GET /api/v1/tasks/:id/events</code> 回放。
            实时界面将在 P2 提供。
          </p>
        </section>
      </main>

      <footer className="footer">
        参考 DeepSeek Harness 的 Agent 与插件思想，独立实现 · 事件持久化于 SQLite，可刷新回放
      </footer>
    </div>
  );
}
