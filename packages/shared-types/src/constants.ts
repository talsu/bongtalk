/**
 * ADR-8 · 공유 상수 단일 정의.
 *
 * 아래 상수는 본 파일에서만 정의됩니다. NFR · D09 · D17 등 모든 도메인은
 * 값을 재정의하지 않고 이 파일의 상수만 import 하여 참조합니다.
 */

/** @everyone 대상 인원 이상 시 UI 확인 모달 (ADR-8). */
export const EVERYONE_CONFIRM_THRESHOLD = 6;

/** 단일 메시지 멘션 합계 이상 시 경고 (ADR-8). */
export const BULK_MENTION_CONFIRM_THRESHOLD = 50;

/** 마우스/키보드 입력 없음 → IDLE 자동 전환 (초). 10분 (ADR-8). */
export const PRESENCE_IDLE_TIMEOUT = 600;

/** 타이핑 Redis 키 TTL (초). 입력 중단 시 자연 소멸 (ADR-8). */
export const TYPING_TTL = 10;

/** 시퀀스 홀 갭 복구 시 최대 페이지 수 (ADR-8 / D17). */
export const GAP_FETCH_MAX_PAGES = 10;

/** 미읽 업데이트 분산 락 TTL (ms) (ADR-8 / D09). */
export const UNREAD_LOCK_TTL = 30000;

/** 시퀀스 홀 감지 대기 타임아웃 (ms) — NFR · D17 합의값 (ADR-8). */
export const SEQ_HOLE_TIMEOUT_MS = 500;

/** 클라이언트 메시지 전송 타임아웃 (ms) 기본값. env 로 override (ADR-8 / D17). */
export const MESSAGE_SEND_TIMEOUT_MS_DEFAULT = 5000;

/** GAP_FETCHING 중 pendingEvents 버퍼 상한. 초과 시 truncated=true (D17). */
export const PENDING_EVENTS_MAX = 200;

/** 타이핑 3명 이상 시 typing:batch 일괄 emit 주기 (ms) 기본값 (D17). */
export const TYPING_BATCH_INTERVAL = 2000;

/** 마지막 disconnect 후 OFFLINE 전환 grace (초) (D17). */
export const PRESENCE_OFFLINE_GRACE = 35;

/** Redis 장애 시 발행되는 seq sentinel — hole 감지 skip (D17). */
export const SEQ_SENTINEL = -1;

/**
 * ADR-8 상수 전체를 단일 객체로도 노출합니다(분산 락/테스트 등에서 키 순회용).
 */
export const SHARED_CONSTANTS = {
  EVERYONE_CONFIRM_THRESHOLD,
  BULK_MENTION_CONFIRM_THRESHOLD,
  PRESENCE_IDLE_TIMEOUT,
  TYPING_TTL,
  GAP_FETCH_MAX_PAGES,
  UNREAD_LOCK_TTL,
  SEQ_HOLE_TIMEOUT_MS,
  MESSAGE_SEND_TIMEOUT_MS_DEFAULT,
  PENDING_EVENTS_MAX,
  TYPING_BATCH_INTERVAL,
  PRESENCE_OFFLINE_GRACE,
  SEQ_SENTINEL,
} as const;
