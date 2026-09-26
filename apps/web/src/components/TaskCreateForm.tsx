import { useEffect, useState, type FormEvent } from 'react';
import type { BalanceResponse, ModelInfo, UserInfo } from 'contracts';
import { DEFAULT_MODEL_ID, PROMPT_MAX_LENGTH } from 'contracts';
import { createTask, fetchModels } from '../api';

/**
 * 创建任务表单：选择模式（demo / live）与模型（服务端受控目录），校验后提交。
 * live 模式需登录：展示服务端计算的预估费用上限（预留口径）与当前余额；
 * 提交即表示同意模型供应商处理任务内容（P5 运营保护要求）。
 */
export function TaskCreateForm({
  user,
  balance,
  onCreated,
}: {
  user: UserInfo | null;
  balance: BalanceResponse | null;
  onCreated: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [estimateMaxCny, setEstimateMaxCny] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchModels()
      .then(({ models: list, estimateMaxCny: estimates }) => {
        if (cancelled) return;
        setModels(list);
        setEstimateMaxCny(estimates);
      })
      .catch(() => {
        // 目录拉取失败不阻塞表单：保留默认模型，创建时由服务端校验兜底
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError('请输入任务内容');
      return;
    }
    if (trimmed.length > PROMPT_MAX_LENGTH) {
      setError(`任务内容不能超过 ${PROMPT_MAX_LENGTH} 字符`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const task = await createTask({
        prompt: trimmed,
        mode,
        ...(mode === 'live' ? { modelId } : {}), // demo 模式不绑定模型
      });
      setPrompt('');
      onCreated(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const estimate = estimateMaxCny[modelId];
  const insufficient =
    mode === 'live' && user !== null && balance !== null && estimate !== undefined && balance.balanceCny < estimate;

  return (
    <section className="card">
      <h2>新建任务</h2>
      <form onSubmit={submit}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="试试：计算 (12+8)*3 的结果"
          rows={3}
          maxLength={PROMPT_MAX_LENGTH}
          disabled={submitting}
        />
        <div className="form-row">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value === 'live' ? 'live' : 'demo')}
            disabled={submitting}
            aria-label="执行模式"
          >
            <option value="demo">模式：demo（演示 · 免费）</option>
            <option value="live">模式：live（真实模型 · 平台额度计费）</option>
          </select>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={submitting || mode !== 'live' || models === null}
            aria-label="模型"
          >
            {(models ?? [{ id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_ID }]).map((m) => (
              <option key={m.id} value={m.id}>
                模型：{m.label}
              </option>
            ))}
          </select>
        </div>
        {mode === 'live' && (
          <div className="form-cost">
            {user === null ? (
              <span className="form-warn">live 任务需先登录（上方账号面板）—— 平台统一管理模型密钥，无需自备</span>
            ) : (
              <>
                <span>
                  预估费用上限 ¥{(estimate ?? 0).toFixed(2)}（按步数上限预留，完成后返还未用额度）
                </span>
                {balance !== null && <span>当前余额 ¥{balance.balanceCny.toFixed(2)}</span>}
                {insufficient && <span className="form-warn">余额不足，请先充值</span>}
              </>
            )}
            <span className="hint">提交即表示同意模型供应商处理任务内容</span>
          </div>
        )}
        <div className="form-footer">
          <span className="hint">
            demo 模式免费无需密钥 · live 由平台密钥调用并记录用量与扣费明细
          </span>
          <button
            type="submit"
            disabled={submitting || prompt.trim().length === 0 || (mode === 'live' && (user === null || insufficient))}
          >
            {submitting ? '创建中…' : '创建并执行'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
    </section>
  );
}
