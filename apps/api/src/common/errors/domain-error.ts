import { ErrorCode } from './error-code.enum';

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'DomainError';
  }
}
