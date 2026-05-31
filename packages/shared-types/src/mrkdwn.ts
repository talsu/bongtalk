import { z } from 'zod';

/**
 * D16 rich content · mrkdwn 공유 정규식 + 파서 가드 한도.
 *
 * FR-RC22: MENTION_USER_RE 는 본 파일에서 단일 export 하며 클라이언트
 * (컴포저 serializer / 렌더러)와 서버(파서)가 동일하게 사용합니다. 정규식이
 * 변경되면 shared-types 버전을 올려야 합니다.
 *
 * FR-MSG-23: 서버 mrkdwn 파서 ReDoS 방어 한도(타임아웃/깊이/노드/AST 크기).
 */

/**
 * ADR-1 — cuid2 식별자 정규식 단일 출처. 멘션 토큰(`@{cuid2}` /
 * `<#cuid2>` / `<@&cuid2>`)이 캡처하는 ID 형식과 정합합니다. 소문자
 * 영숫자 20자 이상(앵커드, ReDoS 안전 — 단일 문자클래스 + 단순 수량자).
 */
export const CUID2_RE = /^[a-z0-9]{20,}$/;

/**
 * cuid2 식별자 zod 스키마. extractMention* 이 추출한 토큰을 그대로
 * 통과시킵니다. `z.string().uuid()` 는 cuid2 를 거부하므로 멘션 ID 는
 * 반드시 본 스키마를 사용합니다(ADR-1 / FR-RC22 ID-형식 정렬).
 */
export const Cuid2Schema = z.string().regex(CUID2_RE, { message: 'invalid cuid2 id' });

/**
 * FR-RC22 — 멘션 사용자 토큰. ProseMirror serializer 가 mentionUser
 * AtomNode 를 `@{cuid2}` 토큰으로 변환하고, 서버 파서가 이 패턴을
 * mention_user AST 노드로 변환합니다.
 *
 * 카노니컬 표기: /@\{([a-z0-9]{20,})\}/g
 *
 * 주: 정규식 리터럴은 lastIndex 상태를 공유하므로, 매칭 시에는 항상 새
 * RegExp 를 만들거나 `mentionUserRe()` 팩토리를 사용하세요.
 */
export const MENTION_USER_RE = /@\{([a-z0-9]{20,})\}/g;

/** stateless 매칭이 필요할 때 매번 새 정규식을 반환하는 팩토리. */
export function mentionUserRe(): RegExp {
  return new RegExp(MENTION_USER_RE.source, MENTION_USER_RE.flags);
}

/** 채널 멘션 토큰: `<#cuid2>` → mention_channel AST 노드. */
export const MENTION_CHANNEL_RE = /<#([a-z0-9]{20,})>/g;

/** 역할 멘션 토큰: `<@&cuid2>` → mention_role AST 노드. */
export const MENTION_ROLE_RE = /<@&([a-z0-9]{20,})>/g;

/** 커스텀 이모지 토큰: `:name:` (소문자 영숫자 + 밑줄 2-32자, ADR-7 slug). */
export const EMOJI_RE = /:([a-z0-9_]{2,32}):/g;

/**
 * `@{cuid2}` 토큰에서 userId 목록을 추출합니다. 입력 정규식의 lastIndex
 * 부수효과를 피하기 위해 내부에서 새 RegExp 를 만듭니다.
 */
export function extractMentionUserIds(raw: string): string[] {
  const re = mentionUserRe();
  const ids: string[] = [];
  for (const m of raw.matchAll(re)) {
    ids.push(m[1]);
  }
  return ids;
}

/**
 * FR-MSG-23 — 서버 mrkdwn 파서 ReDoS 방어 한도 단일 정의.
 * 초과 시 각각 400 + 매핑된 errorCode 를 던집니다.
 */
export const MRKDWN_PARSE_LIMITS = {
  /** 단일 메시지 파싱 타임아웃 (ms). 초과 시 PARSE_TIMEOUT. */
  TIMEOUT_MS: 50,
  /** 파싱 AST 중첩 깊이 최대 레벨. 초과 시 PARSE_DEPTH_EXCEEDED. */
  MAX_DEPTH: 10,
  /** AST 노드 수 최대. 초과 시 PARSE_NODE_LIMIT. */
  MAX_NODES: 500,
  /** contentAst JSON 최대 바이트. 초과 시 PARSE_AST_TOO_LARGE. */
  MAX_AST_BYTES: 64 * 1024,
  /** contentPlain 최대 길이 (문자). */
  MAX_PLAIN_LENGTH: 4000,
} as const;

/** FR-MSG-23 한도 초과 시 사용하는 도메인 에러코드. */
export const MRKDWN_PARSE_ERROR_CODES = [
  'PARSE_TIMEOUT',
  'PARSE_DEPTH_EXCEEDED',
  'PARSE_NODE_LIMIT',
  'PARSE_AST_TOO_LARGE',
] as const;

export type MrkdwnParseErrorCode = (typeof MRKDWN_PARSE_ERROR_CODES)[number];

/**
 * mrkdwn AST 노드 타입(D16). root/paragraph/heading/blockquote/code_block/
 * list/subtext/text/mention_user/mention_channel/mention_role/emoji/link.
 */
export const MRKDWN_AST_NODE_TYPES = [
  'root',
  'paragraph',
  'heading',
  'blockquote',
  'code_block',
  'list',
  'subtext',
  'text',
  'mention_user',
  'mention_channel',
  'mention_role',
  'emoji',
  'link',
] as const;

export type MrkdwnAstNodeType = (typeof MRKDWN_AST_NODE_TYPES)[number];
