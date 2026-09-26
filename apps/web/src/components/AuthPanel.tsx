import { useState } from 'react';
import type { BalanceResponse, UserInfo } from 'contracts';
import { USERNAME_PATTERN, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from 'contracts';
import { loginUser, logoutUser, mockTopup, registerUser } from '../api';

/**
 * 认证与额度面板（P5）：登录 / 注册 / 登出、余额展示、模拟支付充值。
 * 未登录可直接使用 demo 模式；live 任务需登录并由平台额度预留计费。
 */
export function AuthPanel({
  user,
  balance,
  onUserChange,
  onBalanceRefresh,
}: {
  user: UserInfo | null;
  balance: BalanceResponse | null;
  onUserChange: (user: UserInfo | null) => void;
  /** 充值等本地入账后通知父组件重新拉取余额 */
  onBalanceRefresh?: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [topupAmount, setTopupAmount] = useState('');
  const [topupMessage, setTopupMessage] = useState<string | null>(null);

  const authenticate = async (nextMode: 'login' | 'register'): Promise<void> => {
    if (!USERNAME_PATTERN.test(username)) {
      setError('用户名需 3-32 位字母、数字、下划线或连字符');
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      setError(`密码长度需 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { user: next } =
        nextMode === 'login'
          ? await loginUser(username, password)
          : await registerUser(username, password);
      onUserChange(next);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
    } finally {
      setPending(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await logoutUser();
      onUserChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登出失败');
    } finally {
      setPending(false);
    }
  };

  const handleTopup = async (): Promise<void> => {
    const amount = Number(topupAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setTopupMessage('请输入有效金额');
      return;
    }
    setTopupMessage(null);
    setPending(true);
    try {
      // paymentId 每次生成新值：浏览器端模拟一次全新支付回调；服务端按其幂等
      const res = await mockTopup(Math.round(amount * 100) / 100, crypto.randomUUID());
      setTopupMessage(res.recorded ? `充值成功，余额 ¥${res.balanceCny.toFixed(2)}` : '该支付已处理过（幂等跳过）');
      setTopupAmount('');
      onBalanceRefresh?.();
    } catch (err) {
      setTopupMessage(err instanceof Error ? err.message : '充值失败');
    } finally {
      setPending(false);
    }
  };

  if (user === null) {
    return (
      <section className="card auth-card">
        <div className="auth-head">
          <strong>账号</strong>
          <span className="hint">demo 免登录；live 任务需登录并使用平台额度，无需自备模型密钥</span>
        </div>
        <form className="auth-form" onSubmit={(e) => e.preventDefault()}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名（3-32 位字母数字）"
            autoComplete="username"
            disabled={pending}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`密码（至少 ${PASSWORD_MIN_LENGTH} 位）`}
            autoComplete="current-password"
            disabled={pending}
          />
          <div className="auth-buttons">
            <button
              type="button"
              className="primary-button"
              disabled={pending}
              onClick={() => void authenticate('login')}
            >
              登录
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={() => void authenticate('register')}
            >
              注册
            </button>
          </div>
        </form>
        {error && <p className="form-error">{error}</p>}
      </section>
    );
  }

  return (
    <section className="card auth-card">
      <div className="auth-head">
        <strong>{user.username}</strong>
        {balance !== null && (
          <span className="hint">
            余额 ¥{balance.balanceCny.toFixed(2)}
            {balance.reservedCny > 0 && `（进行中预留 ¥${balance.reservedCny.toFixed(2)}）`}
          </span>
        )}
      </div>
      <div className="auth-buttons">
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={topupAmount}
          onChange={(e) => setTopupAmount(e.target.value)}
          placeholder="充值金额（元）"
          className="topup-input"
          disabled={pending}
        />
        <button type="button" className="secondary-button" onClick={() => void handleTopup()} disabled={pending}>
          模拟支付充值
        </button>
        <button type="button" className="link-button" onClick={() => void handleLogout()} disabled={pending}>
          退出登录
        </button>
      </div>
      {topupMessage && <p className="hint">{topupMessage}</p>}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
