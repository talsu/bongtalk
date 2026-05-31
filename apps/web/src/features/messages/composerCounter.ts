import { MESSAGE_MAX_LENGTH } from '@qufox/shared-types';

/**
 * S02 — 컴포저 실시간 글자수 카운터 (FR-MSG-03 / FR-RC17).
 *
 * 최대 4,000자(MESSAGE_MAX_LENGTH, shared-types 단일 출처). 한도 근처
 * (remaining ≤ WARN) 부터 카운터를 노출하고, 초과 시 danger + 전송 차단.
 * 길이 기준은 UTF-16 length — 서버 enforceContentLength(contentPlain) 와
 * 동일 단위입니다(컴포저는 raw 길이로 보수적으로 카운트).
 */
export const COUNTER_WARN_THRESHOLD = 100;

export interface CounterState {
  length: number;
  remaining: number;
  /** 한도 초과 — 전송 차단 + danger 색상. */
  overLimit: boolean;
  /** 한도 근처(remaining ≤ WARN) — 카운터 노출 + 경고 색상. */
  warn: boolean;
  /** 카운터를 화면에 표시할지(경고 구간부터). */
  shouldShow: boolean;
  /** 길이 관점에서 전송 가능 여부(빈 입력 게이트는 호출측 책임). */
  canSend: boolean;
}

export function computeCounter(draft: string): CounterState {
  const length = draft.length;
  const remaining = MESSAGE_MAX_LENGTH - length;
  const overLimit = length > MESSAGE_MAX_LENGTH;
  const warn = remaining <= COUNTER_WARN_THRESHOLD;
  return {
    length,
    remaining,
    overLimit,
    warn,
    shouldShow: warn,
    canSend: !overLimit,
  };
}
