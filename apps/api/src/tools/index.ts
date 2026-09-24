import { ToolRegistry } from './registry';
import { calculateTool } from './calculate';
import { textStatsTool } from './textStats';

export { ToolRegistry, validateToolInput } from './registry';
export type { InputViolation } from './registry';
export { calculateTool, evaluateExpression } from './calculate';
export { textStatsTool } from './textStats';

/** 创建默认工具集：仅低风险纯计算工具（白名单），无命令执行、文件与网络访问 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(calculateTool);
  registry.register(textStatsTool);
  return registry;
}
