/**
 * task-046 iter7 (P2 / P3 carry-over): consolidated error message + recovery
 * action mapping. All mutation onError handlers should run errors through
 * `friendlyError(err)` to produce consistent toast / banner text.
 *
 * 정책:
 *  - errorCode 가 있는 경우 명확한 한국어 메시지 + recovery 힌트
 *  - errorCode 가 없는 경우 status code 기반 기본 메시지
 *  - 알 수 없는 에러: "잠시 후 다시 시도해 주세요" + retry 액션
 */

export type RecoveryAction = 'retry' | 'cancel' | 'refresh' | 'login' | 'none';

export interface FriendlyError {
  /** 사용자에게 표시할 한국어 메시지 */
  message: string;
  /** 권장 recovery action */
  recovery: RecoveryAction;
  /** 원본 errorCode (telemetry 용) */
  errorCode?: string;
  /** HTTP status (telemetry 용) */
  status?: number;
}

interface ApiError extends Error {
  errorCode?: string;
  status?: number;
}

/**
 * errorCode → 한국어 message + recovery action.
 * unknown 항목은 default fallback 으로 떨어짐.
 */
const CODE_TABLE: Record<string, { message: string; recovery: RecoveryAction }> = {
  // Auth
  AUTH_INVALID_TOKEN: {
    message: '세션이 만료되었습니다. 다시 로그인해 주세요.',
    recovery: 'login',
  },
  AUTH_INVALID_CREDENTIALS: {
    message: '이메일 또는 비밀번호가 올바르지 않습니다.',
    recovery: 'none',
  },
  AUTH_EMAIL_TAKEN: { message: '이미 사용 중인 이메일입니다.', recovery: 'none' },
  AUTH_USERNAME_TAKEN: { message: '이미 사용 중인 사용자명입니다.', recovery: 'none' },
  AUTH_WEAK_PASSWORD: { message: '비밀번호가 너무 약합니다.', recovery: 'none' },
  AUTH_ACCOUNT_LOCKED: {
    message: '로그인 시도 횟수 초과로 계정이 잠겼습니다. 잠시 후 다시 시도해 주세요.',
    recovery: 'cancel',
  },
  AUTH_SESSION_COMPROMISED: {
    message: '세션이 무효화되었습니다. 다시 로그인해 주세요.',
    recovery: 'login',
  },

  // Validation
  VALIDATION_FAILED: { message: '입력값을 다시 확인해 주세요.', recovery: 'none' },

  // Permissions
  WORKSPACE_INSUFFICIENT_ROLE: { message: '권한이 부족합니다.', recovery: 'none' },
  WORKSPACE_TARGET_NOT_MEMBER: {
    message: '대상 사용자가 워크스페이스 멤버가 아닙니다.',
    recovery: 'refresh',
  },
  WORKSPACE_CANNOT_DEMOTE_OWNER: { message: '오너 역할은 변경할 수 없습니다.', recovery: 'none' },
  WORKSPACE_CANNOT_REMOVE_OWNER: {
    message: '오너는 제거할 수 없습니다 — 먼저 소유권을 이전하세요.',
    recovery: 'none',
  },
  WORKSPACE_OWNER_MUST_TRANSFER: { message: '소유권 이전 후 떠날 수 있습니다.', recovery: 'none' },

  // Channel
  CHANNEL_NOT_FOUND: { message: '채널을 찾을 수 없습니다.', recovery: 'refresh' },
  MESSAGE_NOT_FOUND: { message: '메시지를 찾을 수 없습니다.', recovery: 'refresh' },

  // Rate limit / backpressure
  RATE_LIMIT_EXCEEDED: { message: '잠시 후 다시 시도해 주세요.', recovery: 'retry' },
  BACKPRESSURE: { message: '서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.', recovery: 'retry' },

  // Generic
  INTERNAL_ERROR: {
    message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    recovery: 'retry',
  },
};

/**
 * status code → fallback message + recovery.
 */
function fromStatus(status: number): { message: string; recovery: RecoveryAction } {
  if (status === 401) return { message: '인증이 필요합니다.', recovery: 'login' };
  if (status === 403) return { message: '권한이 없습니다.', recovery: 'none' };
  if (status === 404) return { message: '요청한 자원을 찾을 수 없습니다.', recovery: 'refresh' };
  if (status === 409)
    return { message: '충돌이 발생했습니다. 새로고침 후 다시 시도해 주세요.', recovery: 'refresh' };
  if (status === 429)
    return { message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', recovery: 'retry' };
  if (status >= 500 && status < 600) {
    return { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', recovery: 'retry' };
  }
  if (status >= 400 && status < 500) {
    return { message: '요청을 처리할 수 없습니다.', recovery: 'none' };
  }
  return { message: '알 수 없는 오류입니다. 잠시 후 다시 시도해 주세요.', recovery: 'retry' };
}

export function friendlyError(err: unknown): FriendlyError {
  if (err instanceof Error) {
    const apiErr = err as ApiError;
    const code = apiErr.errorCode;
    const status = apiErr.status;
    if (code && CODE_TABLE[code]) {
      const { message, recovery } = CODE_TABLE[code];
      return { message, recovery, errorCode: code, status };
    }
    if (typeof status === 'number') {
      const { message, recovery } = fromStatus(status);
      return { message, recovery, errorCode: code, status };
    }
    // network / parse error
    return {
      message: '네트워크 연결을 확인해 주세요.',
      recovery: 'retry',
      errorCode: code,
    };
  }
  return {
    message: '알 수 없는 오류입니다. 잠시 후 다시 시도해 주세요.',
    recovery: 'retry',
  };
}

/**
 * recovery action 라벨 — UI button 텍스트.
 */
export const RECOVERY_LABEL: Record<RecoveryAction, string> = {
  retry: '다시 시도',
  cancel: '취소',
  refresh: '새로고침',
  login: '로그인',
  none: '확인',
};
