import type { ToolDefinition } from 'contracts';

/**
 * text_stats：文本统计工具。
 * 权限与边界：纯函数计算，无文件 / 网络 / 命令访问；
 * 输入长度受注册表校验上限约束。
 */

export const textStatsTool: ToolDefinition<{ text: string }> = {
  name: 'text_stats',
  description: '统计文本的基本指标：字符数、词数、行数。纯计算工具，无任何外部访问。',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '待统计的文本内容' },
    },
    required: ['text'],
  },
  async execute({ text }) {
    return {
      ok: true,
      data: {
        characters: text.length,
        words: text.split(/\s+/).filter(Boolean).length,
        lines: text.split('\n').length,
      },
    };
  },
};
