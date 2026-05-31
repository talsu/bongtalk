import { MESSAGE_SEND_TIMEOUT_MS_DEFAULT } from '@qufox/shared-types';

/**
 * S09 (FR-RT-05): 클라이언트 메시지 전송 타임아웃(ms) 해석 — 순수 함수.
 *
 * env(`VITE_MESSAGE_SEND_TIMEOUT_MS`) 가 양의 정수로 주어지면 그 값을,
 * 아니면 공유 상수 `MESSAGE_SEND_TIMEOUT_MS_DEFAULT`(5000) 를 사용합니다.
 * 0/음수/NaN/빈 문자열 등 비정상 override 는 기본값으로 폴백합니다(과설계
 * 방지 — 타임아웃 비활성화 같은 별도 모드는 두지 않습니다).
 *
 * env 값을 인자로 주입받아 순수성을 유지합니다(호출부에서
 * `import.meta.env.VITE_MESSAGE_SEND_TIMEOUT_MS` 를 넘김). 단위 테스트는
 * `import.meta` 모킹 없이 분기만 검증합니다.
 */
export function resolveSendTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return MESSAGE_SEND_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MESSAGE_SEND_TIMEOUT_MS_DEFAULT;
  return Math.floor(n);
}

/** 호출부 편의 래퍼: Vite env 에서 override 를 읽어 해석합니다. */
export function messageSendTimeoutMs(): number {
  return resolveSendTimeoutMs(
    (import.meta.env?.VITE_MESSAGE_SEND_TIMEOUT_MS as string | undefined) ?? undefined,
  );
}
