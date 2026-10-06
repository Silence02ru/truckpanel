import type { ErrorCode } from '@truckpanel/shared';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new AppError(401, 'unauthorized', 'Sign in to continue.');
export const forbidden = () => new AppError(403, 'forbidden', 'You do not have permission to do this.');
