/** JSON-RPC error codes used by wsd. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Application error; `data.code` carries a string code like ENOENT. */
  AppError: -32000,
} as const;

export class WsdError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly rpcCode: number = RpcErrorCode.AppError,
  ) {
    super(message);
    this.name = 'WsdError';
  }
}

export function invalidParams(message: string): WsdError {
  return new WsdError('EINVAL', message, RpcErrorCode.InvalidParams);
}

export function toRpcError(err: unknown): { code: number; message: string; data?: unknown } {
  if (err instanceof WsdError) return { code: err.rpcCode, message: err.message, data: { code: err.code } };
  const e = err as NodeJS.ErrnoException;
  if (e && typeof e === 'object' && typeof e.code === 'string') {
    return { code: RpcErrorCode.AppError, message: e.message, data: { code: e.code } };
  }
  return { code: RpcErrorCode.InternalError, message: e instanceof Error ? e.message : String(err) };
}
