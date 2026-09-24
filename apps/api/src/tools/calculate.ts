import type { ToolDefinition, ToolResult } from 'contracts';

/**
 * calculate：算术表达式求值工具。
 * 权限与边界：纯函数计算，无文件 / 网络 / 命令访问；
 * 手写递归下降解析器（不使用 eval，杜绝代码注入）。
 * 支持 + - * / %、括号、小数与一元负号。
 */

/** 受控求值错误：转为 ToolResult.error，不向外抛异常 */
class ExpressionError extends Error {}

export const calculateTool: ToolDefinition<{ expression: string }> = {
  name: 'calculate',
  description:
    '计算算术表达式的值，支持 + - * / %、括号、小数与一元负号。纯计算工具，无任何外部访问。',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '待求值的算术表达式，如 (1+2)*3' },
    },
    required: ['expression'],
  },
  async execute(input) {
    return evaluateExpression(input.expression);
  },
};

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '%' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

/** 分词：非法字符或非法数字（如 1.2.3）抛 ExpressionError */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < source.length && /[0-9.]/.test(source[i]!)) {
        num += source[i];
        i++;
      }
      const value = Number(num);
      if (num.includes('.', num.indexOf('.') + 1) || Number.isNaN(value)) {
        throw new ExpressionError('数字格式错误');
      }
      tokens.push({ kind: 'num', value });
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    throw new ExpressionError(`包含非法字符："${ch}"`);
  }
  return tokens;
}

/** 表达式求值：语法错误与除零统一转为受控 ToolResult */
export function evaluateExpression(expression: string): ToolResult {
  try {
    const tokens = tokenize(expression);
    if (tokens.length === 0) throw new ExpressionError('表达式为空');
    let pos = 0;

    const peek = (): Token | undefined => tokens[pos];
    const take = (): Token | undefined => tokens[pos++];

    const parsePrimary = (): number => {
      const token = take();
      if (!token) throw new ExpressionError('表达式不完整');
      if (token.kind === 'num') return token.value;
      if (token.kind === 'lparen') {
        const value = parseExpression();
        const closing = take();
        if (!closing || closing.kind !== 'rparen') {
          throw new ExpressionError('括号不匹配');
        }
        return value;
      }
      throw new ExpressionError('运算符位置错误');
    };

    const parseFactor = (): number => {
      const token = peek();
      if (token && token.kind === 'op' && token.value === '-') {
        take(); // 一元负号
        return -parseFactor();
      }
      return parsePrimary();
    };

    const parseTerm = (): number => {
      let left = parseFactor();
      while (true) {
        const token = peek();
        if (!token || token.kind !== 'op' || !['*', '/', '%'].includes(token.value)) break;
        take();
        const right = parseFactor();
        if ((token.value === '/' || token.value === '%') && right === 0) {
          throw new ExpressionError('除数为零');
        }
        left =
          token.value === '*' ? left * right : token.value === '/' ? left / right : left % right;
      }
      return left;
    };

    const parseExpression = (): number => {
      let left = parseTerm();
      while (true) {
        const token = peek();
        if (!token || token.kind !== 'op' || (token.value !== '+' && token.value !== '-')) break;
        take();
        const right = parseTerm();
        left = token.value === '+' ? left + right : left - right;
      }
      return left;
    };

    const result = parseExpression();
    if (pos !== tokens.length) throw new ExpressionError('表达式包含多余内容');
    if (!Number.isFinite(result)) throw new ExpressionError('计算结果溢出');
    // 消除浮点尾差：0.1+0.2 → 0.3（保留 12 位有效数字）
    return { ok: true, data: Number(result.toPrecision(12)) };
  } catch (err) {
    if (err instanceof ExpressionError) return { ok: false, error: err.message };
    return { ok: false, error: `求值失败：${String(err)}` };
  }
}
