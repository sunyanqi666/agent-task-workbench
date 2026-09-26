import { useCallback, useEffect, useState } from 'react';
import type { BalanceResponse, HealthInfo, UserInfo } from 'contracts';
import { fetchBalance, fetchHealth, fetchMe } from './api';
import { AuthPanel } from './components/AuthPanel';
import { TaskCreateForm } from './components/TaskCreateForm';
import { TaskList } from './components/TaskList';
import { TaskDetail } from './components/TaskDetail';

/** hash 路由：#/tasks/:id → 详情；其余 → 首页（创建 + 列表）。
 *  刷新后从 hash 恢复视图，任务数据从持久化事件回放，天然一致。 */
function useTaskIdFromHash(): string | null {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const match = hash.match(/^#\/tasks\/([0-9a-zA-Z-]+)$/);
  return match?.[1] ?? null;
}

export default function App() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [down, setDown] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const activeTaskId = useTaskIdFromHash();

  // 登录态变化（或任务创建扣费后）刷新余额；未登录清空
  const refreshBalance = useCallback((u: UserInfo | null) => {
    if (!u) {
      setBalance(null);
      return;
    }
    fetchBalance()
      .then(setBalance)
      .catch(() => setBalance(null));
  }, []);

  // 任务终态结算（释放预留）后刷新余额；未登录时 401 静默清空
  const refreshBalanceOnSettled = useCallback(() => {
    fetchBalance()
      .then(setBalance)
      .catch(() => setBalance(null));
  }, []);

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

  // 启动时恢复会话（HttpOnly Cookie；服务端返回 user: null 即未登录）
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then(({ user: u }) => {
        if (cancelled) return;
        setUser(u);
        refreshBalance(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshBalance]);

  const badgeText = down
    ? 'API 未连接'
    : health === null
      ? '连接中…'
      : `API 正常 · v${health.version}`;

  const openTask = (id: string) => {
    window.location.hash = `#/tasks/${id}`;
  };
  const backHome = () => {
    window.location.hash = '';
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Agent Task Workbench</h1>
          <p className="subtitle">可观察的 Agent 任务执行：创建 → 执行 → 工具调用 → 实时回放</p>
        </div>
        <div className={`badge ${down ? 'badge-down' : ''}`}>{badgeText}</div>
      </header>

      <main>
        <AuthPanel
          user={user}
          balance={balance}
          onUserChange={(u) => {
            setUser(u);
            refreshBalance(u);
          }}
          onBalanceRefresh={refreshBalanceOnSettled}
        />
        {activeTaskId ? (
          <TaskDetail
            id={activeTaskId}
            onBack={backHome}
            onOpenTask={openTask}
            onSettled={refreshBalanceOnSettled}
          />
        ) : (
          <>
            <TaskCreateForm
              user={user}
              balance={balance}
              onCreated={(id) => {
                openTask(id);
                refreshBalance(user); // live 创建即扣预留，刷新余额展示
              }}
            />
            <TaskList onOpen={openTask} />
          </>
        )}
      </main>

      <footer className="footer">
        参考 DeepSeek Harness 的 Agent 与插件思想，独立实现 · 事件持久化于 SQLite，可刷新回放
      </footer>
    </div>
  );
}
