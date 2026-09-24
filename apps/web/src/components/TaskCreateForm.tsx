import { useEffect, useState, type FormEvent } from 'react';
import type { ModelInfo } from 'contracts';
import { DEFAULT_MODEL_ID, PROMPT_MAX_LENGTH } from 'contracts';
import { createTask, fetchModels } from '../api';

/**
 * 创建任务表单：选择模式（demo / live）与模型（服务端受控目录），校验后提交。
 * live 模式需服务端配置模型密钥，未配置时服务端返回 503 并给出明确提示。
 */
export function TaskCreateForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchModels()
      .then(({ models }) => {
        if (!cancelled) setModels(models);
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
            <option value="demo">模式：demo（演示）</option>
            <option value="live">模式：live（真实模型）</option>
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
        <div className="form-footer">
          <span className="hint">
            demo 模式无需密钥 · live 需服务端配置密钥并记录用量
          </span>
          <button type="submit" disabled={submitting || prompt.trim().length === 0}>
            {submitting ? '创建中…' : '创建并执行'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
    </section>
  );
}
