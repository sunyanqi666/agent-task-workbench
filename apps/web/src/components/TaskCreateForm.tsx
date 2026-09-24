import { useState, type FormEvent } from 'react';
import { PROMPT_MAX_LENGTH } from 'contracts';
import { createTask } from '../api';

/** 创建任务表单：校验后提交，成功后跳转详情页实时观察执行过程 */
export function TaskCreateForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      const task = await createTask({ prompt: trimmed });
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
        <div className="form-footer">
          <span className="hint">demo 模式 · 算式任务调用 calculate，其他调用 text_stats</span>
          <button type="submit" disabled={submitting || prompt.trim().length === 0}>
            {submitting ? '创建中…' : '创建并执行'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
    </section>
  );
}
