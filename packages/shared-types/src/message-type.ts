import { z } from 'zod';

/**
 * S04 (ADR-2 / FR-MSG-19 / FR-RC10) — MessageType 단일 카노니컬 정의.
 *
 * 이 파일이 메시지 타입 enum 의 유일한 출처입니다. Prisma enum(스키마),
 * apps/api(시스템 메시지 생성·DTO), apps/web(시스템 메시지 렌더러)이 모두
 * 본 파일을 import 합니다. D01·D16 은 이 enum 만 참조하며 별도 명명체계
 * (USER_JOIN / CHANNEL_NAME_CHANGE 등)는 폐기됐습니다(ADR-2 폐기 목록).
 *
 * SYSTEM_* 공통 규칙(FR-MSG-19):
 *   - authorType = SYSTEM
 *   - grouped = false 강제(항상 독립 행, 인접 그루핑 재계산 트리거)
 *   - 편집·삭제 컨텍스트 메뉴 미표시
 *   - contentRaw 는 서버가 생성하는 템플릿
 */
export const MESSAGE_TYPES = [
  'DEFAULT',
  'SYSTEM_MEMBER_JOINED',
  'SYSTEM_MEMBER_LEFT',
  'SYSTEM_MEMBER_BANNED',
  'SYSTEM_PIN',
  'SYSTEM_CHANNEL_RENAME',
  'SYSTEM_CHANNEL_TOPIC_CHANGED',
  'SYSTEM_CHANNEL_ARCHIVED',
  'SYSTEM_THREAD_BROADCAST',
] as const;

export const MessageTypeSchema = z.enum(MESSAGE_TYPES);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/** 시스템 메시지 타입(DEFAULT 제외). authorType=SYSTEM 강제 대상. */
export const SYSTEM_MESSAGE_TYPES = MESSAGE_TYPES.filter(
  (t) => t !== 'DEFAULT',
) as readonly Exclude<MessageType, 'DEFAULT'>[];

/**
 * 주어진 타입이 시스템 메시지인지 판정합니다. 렌더러(편집·삭제 UI 숨김 +
 * grouped=false 강제)와 그루핑 재계산이 단일 술어를 공유하도록 export 합니다.
 */
export function isSystemMessageType(type: MessageType | null | undefined): boolean {
  return type != null && type !== 'DEFAULT';
}

/**
 * SYSTEM_* 타입별 contentRaw 템플릿 토큰(FR-MSG-19 표). 서버가 시스템 메시지
 * 생성 시 변수(`username` / `old` / `new` / `topic`)를 채워 contentRaw 를
 * 만듭니다. 클라이언트 렌더러는 이미 채워진 contentRaw 를 그대로 표시하므로
 * 본 템플릿은 서버 전용입니다.
 *
 * 토큰 구문은 `{name}` — 정규식 치환이 아니라 단순 split/join 으로 처리해
 * ReDoS·이스케이프 이슈를 원천 차단합니다.
 */
export const SYSTEM_MESSAGE_TEMPLATES: Record<Exclude<MessageType, 'DEFAULT'>, string> = {
  SYSTEM_MEMBER_JOINED: '{username}이(가) 서버에 참가했습니다.',
  SYSTEM_MEMBER_LEFT: '{username}이(가) 서버를 떠났습니다.',
  SYSTEM_MEMBER_BANNED: '{username}이(가) 추방되었습니다.',
  SYSTEM_PIN: '{username}이(가) 메시지를 고정했습니다.',
  SYSTEM_CHANNEL_RENAME: '{username}이(가) 채널 이름을 {old}에서 {new}로 변경했습니다.',
  SYSTEM_CHANNEL_TOPIC_CHANGED: '{username}이(가) 채널 토픽을 "{topic}"으로 변경했습니다.',
  SYSTEM_CHANNEL_ARCHIVED: '{username}이(가) 채널을 보관했습니다.',
  SYSTEM_THREAD_BROADCAST: '{username}이(가) 스레드 메시지를 채널에 게시했습니다.',
};

/**
 * 시스템 메시지 contentRaw 를 템플릿 + 변수로 렌더합니다. 누락된 변수는 빈
 * 문자열로 치환됩니다(forward-compat). 정규식 미사용 — `{key}` 리터럴
 * split/join 으로 안전하게 처리합니다.
 */
export function renderSystemMessageTemplate(
  type: Exclude<MessageType, 'DEFAULT'>,
  vars: Record<string, string>,
): string {
  let out = SYSTEM_MESSAGE_TEMPLATES[type];
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value);
  }
  // 채워지지 않은 토큰은 빈 문자열로 제거(예: vars 누락).
  out = out.replace(/\{[a-z]+\}/g, '');
  return out;
}
