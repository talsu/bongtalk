import { v5 as uuidv5 } from 'uuid';

/**
 * S77c (D14 / FR-PS-19): Message.authorId 익명화 타겟인 SYSTEM_ANON 시스템 사용자 ID 해석.
 *
 * seed.ts (그리고 scripts/workers 의 workspace purge)와 **동일한** 결정론 규칙을 재사용한다 —
 * 별도 ANON 사용자를 만들지 않고 S72 가 이미 시드/보장하는 `user:system-anon` 행을 그대로 쓴다:
 *
 *   1. env `ANON_AUTHOR_UUID` 가 있으면 그 값을 우선한다(운영 오버라이드).
 *   2. 없으면 `SEED_NAMESPACE`(없으면 nil UUID) namespace + `user:system-anon` 키로 uuid v5 를
 *      결정론적으로 유도한다(seed.ts 의 `id('user','system-anon')` 와 글자 단위 동일).
 *
 * 이 함수는 ID 만 계산한다 — 해당 User 행의 존재는 seed/purge 가 보장하며(FK 유효성), 크론은
 * 익명화 전에 행 존재를 가드한다(없으면 스킵 + 경고). 평문 시크릿/PII 를 다루지 않는 순수 함수.
 */
const SYSTEM_ANON_KEY = 'user:system-anon';

export function resolveSystemAnonUserId(): string {
  const override = process.env.ANON_AUTHOR_UUID;
  if (override && override.length > 0) return override;
  const namespace = process.env.SEED_NAMESPACE ?? '00000000-0000-0000-0000-000000000000';
  return uuidv5(SYSTEM_ANON_KEY, namespace);
}
