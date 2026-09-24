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
            当前为 P0 项目骨架：前后端、数据契约、数据库迁移与健康检查已就绪。
            任务创建、Agent 执行与实时步骤将在 P1 / P2 提供。
          </p>
        </section>

        <section className="card">
          <h2>项目阶段</h2>
          <ol className="phases">
            <li className="done">P0 项目骨架（当前）</li>
            <li>P1 可运行任务：状态机、模拟模型、工具调用</li>
            <li>P2 实时界面：SSE 步骤流与回放</li>
            <li>P3 真实模型接入与取消 / 重试 / 超时</li>
            <li>P4 工程化与作品集交付</li>
          </ol>
        </section>
      </main>

      <footer className="footer">
        参考 DeepSeek Harness 的 Agent 与插件思想，独立实现 · 事件持久化于 SQLite，可刷新回放
      </footer>
    </div>
  );
}
