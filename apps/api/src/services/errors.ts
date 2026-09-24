/** 服务层错误：携带 HTTP 状态码与机器可读 code，由路由层统一转为 ApiError */

export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 资源不存在 → 404 */
export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, 404, 'not_found');
  }
}

/** 状态机非法迁移或幂等冲突 → 409 */
export class ConflictError extends AppError {
  constructor(message = '状态冲突') {
    super(message, 409, 'status_conflict');
  }
}

/** 输入校验失败 → 400 */
export class ValidationError extends AppError {
  constructor(message = '输入无效') {
    super(message, 400, 'bad_request');
  }
}
