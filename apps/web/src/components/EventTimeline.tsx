import type { ReactNode } from 'react';
import type { TaskEvent, TaskEventPayloads, TaskEventType } from 'contracts';

/** 事件时间线：回放与实时流共用同一渲染，按 seq 排序展示 */

const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function formatClock(iso: string): string {
  return TIME_FORMAT.format(new Date(iso));
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const TYPE_LABEL: Record<TaskEventType, string> = {
  'task.created': '创建任务',
  'task.started': '开始执行',
  'model.output': '模型输出',
  'tool.started': '调用工具',
  'tool.completed': '工具完成',
  'tool.failed': '工具失败',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.canceled': '任务取消',
};

export function EventTimeline({ events }: { events: TaskEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((event) => (
        <TimelineItem key={event.seq} event={event} />
      ))}
    </ol>
  );
}

function TimelineItem({ event }: { event: TaskEvent }) {
  let body: ReactNode;
  if (event.type === 'task.created') {
    const payload = event.payload as TaskEventPayloads['task.created'];
    body = <p className="tl-text">{payload.prompt}</p>;
  } else if (event.type === 'model.output') {
    const payload = event.payload as TaskEventPayloads['model.output'];
    body = <p className="tl-text">{payload.text}</p>;
  } else if (event.type === 'tool.started') {
    const payload = event.payload as TaskEventPayloads['tool.started'];
    body = <pre className="tl-code">{json({ name: payload.name, input: payload.input })}</pre>;
  } else if (event.type === 'tool.completed') {
    const payload = event.payload as TaskEventPayloads['tool.completed'];
    body = (
      <pre className="tl-code">
        {json({ name: payload.name, output: payload.output, durationMs: payload.durationMs })}
      </pre>
    );
  } else if (event.type === 'tool.failed') {
    const payload = event.payload as TaskEventPayloads['tool.failed'];
    body = <p className="tl-text tl-danger">{payload.error}</p>;
  } else if (event.type === 'task.completed') {
    const payload = event.payload as TaskEventPayloads['task.completed'];
    body = <p className="tl-text tl-success">{payload.summary}</p>;
  } else if (event.type === 'task.failed') {
    const payload = event.payload as TaskEventPayloads['task.failed'];
    body = (
      <p className="tl-text tl-danger">
        {payload.errorCode}：{payload.message}
      </p>
    );
  } else {
    // task.started / task.canceled：无载荷
    body = <span />;
  }

  const isTerminal =
    event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.canceled';

  return (
    <li className={`tl-item tl-${event.type.replace('.', '-')} ${isTerminal ? 'tl-terminal' : ''}`}>
      <div className="tl-head">
        <span className="tl-label">{TYPE_LABEL[event.type]}</span>
        <span className="tl-seq">#{event.seq}</span>
        <span className="tl-time">{formatClock(event.createdAt)}</span>
      </div>
      {body}
    </li>
  );
}
