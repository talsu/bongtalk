import {
  parseMrkdwn,
  enforceContentLength,
  enforceAstByteSize,
  MrkdwnParseError,
  type RichTextRoot,
} from '@qufox/shared-types';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S02 — mrkdwn 송수신 코어 파이프라인 (FR-MSG-01 / FR-MSG-03 / FR-MSG-20 /
 * FR-MSG-23).
 *
 * contentRaw(원본) → contentAst(rich_text AST) + contentPlain(평문) 으로
 * 변환하고, 4,000자 / AST 64KB / 깊이 / 노드 한도를 enforce 합니다. 파서
 * (`@qufox/shared-types`)는 환경 중립이라 도메인 에러를 모릅니다 — 본
 * 모듈이 MrkdwnParseError → DomainError(ErrorCode) 로 매핑해 전역
 * HttpException 필터가 올바른 HTTP 상태로 변환하게 합니다.
 *
 * 길이 한도(MESSAGE_TOO_LONG)는 contentPlain 기준으로 enforce 합니다
 * (FR-MSG-03 — "최대 4,000자, contentPlain 기준, 애플리케이션 계층").
 *
 * NOTE(S02 정확화 — 리뷰 MED#4): 실사용에서 이 plain 기준 enforce 는
 * 방어선(defensive)입니다. 컨트롤러 DTO `MessageContentSchema.max(4000)`
 * 가 raw 본문을 먼저 캡하고, 모든 노드 타입에서 plain ≤ raw 이므로
 * enforceContentLength(plain) 는 직접 호출(유닛 테스트) 외에는 거의
 * 발화하지 않습니다. (부수효과: DTO 캡이 파서로 들어오는 거대 입력
 * DoS 경로도 함께 차단합니다.)
 */

const PARSE_ERROR_TO_DOMAIN: Record<MrkdwnParseError['code'], ErrorCode> = {
  MESSAGE_TOO_LONG: ErrorCode.MESSAGE_TOO_LONG,
  PARSE_TIMEOUT: ErrorCode.PARSE_TIMEOUT,
  PARSE_DEPTH_EXCEEDED: ErrorCode.PARSE_DEPTH_EXCEEDED,
  PARSE_NODE_LIMIT: ErrorCode.PARSE_NODE_LIMIT,
  PARSE_AST_TOO_LARGE: ErrorCode.PARSE_AST_TOO_LARGE,
};

export interface ProcessedContent {
  contentRaw: string;
  contentAst: RichTextRoot;
  contentPlain: string;
}

/**
 * 원본 mrkdwn 을 파싱·검증해 저장 가능한 3분리 구조로 변환합니다. 한도
 * 위반은 DomainError 로 던집니다(전역 필터가 HTTP 매핑).
 */
export function processMrkdwn(contentRaw: string): ProcessedContent {
  try {
    const { ast, plain } = parseMrkdwn(contentRaw);
    // 길이는 평문 기준(FR-MSG-03). 파싱 후 검사해 AST/plain 이 일관되게
    // 도출된 값으로 판정합니다.
    enforceContentLength(plain);
    enforceAstByteSize(ast);
    return { contentRaw, contentAst: ast, contentPlain: plain };
  } catch (e) {
    if (e instanceof MrkdwnParseError) {
      throw new DomainError(PARSE_ERROR_TO_DOMAIN[e.code], e.message);
    }
    throw e;
  }
}
