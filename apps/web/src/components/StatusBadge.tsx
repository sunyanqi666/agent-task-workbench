import type { TaskStatus } from 'contracts';

/** 状态徽章：任务列表与详情共用（类名沿用 P0 预留的样式） */
const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

const STATUS_CLASS: Record<TaskStatus, string> = {
  queued: 'status-pending',
  running: 'status-running',
  completed: 'status-succeeded',
  failed: 'status-failed',
  canceled: 'status-cancelled',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}
