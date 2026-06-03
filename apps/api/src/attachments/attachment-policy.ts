import { BLOCKED_EXTENSIONS } from '@qufox/shared-types';

/**
 * S55 (D11 / FR-AM-20 + FR-CH-18) — 첨부 업로드 정책 병합 pure helpers. 서비스와
 * unit 테스트가 공유한다. DB/IO 의존이 없는 순수 함수만 둔다.
 */

export interface UploadPolicyInputs {
  /** 채널 오버라이드(있으면 최우선). null = 미설정. */
  channelMaxBytes: bigint | null;
  /** 워크스페이스 설정(채널 미설정 시 폴백). null = 미설정. */
  workspaceMaxBytes: bigint | null;
  /** 전역 기본 상한(둘 다 미설정 시 폴백). S3Service.maxBytes. */
  defaultMaxBytes: number;
  /** 워크스페이스 추가 차단 확장자(전역 BLOCKED_EXTENSIONS 와 합집합). */
  workspaceBlockedExtensions: readonly string[];
}

/**
 * FR-AM-20: 유효 최대 첨부 크기를 결정한다. 우선순위 채널 → 워크스페이스 → 전역.
 * 채널/워크스페이스 값이 전역 상한을 초과해도 그대로 존중하지 않고 전역 상한으로
 * 캡한다(전역은 하드 상한 — 서버 메모리/스토리지 보호). 반환은 number(헤드 비교용,
 * 100MB 이하라 안전).
 */
export function effectiveMaxBytes(inputs: UploadPolicyInputs): number {
  const override = inputs.channelMaxBytes ?? inputs.workspaceMaxBytes ?? null;
  if (override === null) return inputs.defaultMaxBytes;
  const overrideNum = Number(override);
  // 전역 하드 상한으로 캡(정책 값이 더 크면 전역을 적용).
  return Math.min(overrideNum, inputs.defaultMaxBytes);
}

/**
 * FR-AM-20: 전역 BLOCKED_EXTENSIONS + 워크스페이스 추가 차단의 합집합(소문자, 점 제외).
 * Set 으로 중복을 제거한다.
 */
export function mergedBlockedExtensions(workspaceBlocked: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of BLOCKED_EXTENSIONS) out.add(e.toLowerCase());
  for (const e of workspaceBlocked) out.add(e.toLowerCase());
  return out;
}

/**
 * FR-AM-20: 확장자가 합집합 블랙리스트에 속하는지. ext 가 null(확장자 없음)이면 false.
 */
export function isBlockedByPolicy(
  ext: string | null,
  workspaceBlocked: readonly string[],
): boolean {
  if (!ext) return false;
  return mergedBlockedExtensions(workspaceBlocked).has(ext.toLowerCase());
}

/**
 * FR-AM-17: 브라우저 인라인 렌더 시 stored-XSS/content-sniffing 위험이 있는 MIME 은
 * `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` 를 강제해
 * 인라인 실행을 막는다. SVG(스크립트 임베드 가능)·HTML·XML·기타 텍스트/스크립트 계열이
 * 대상이다. 이미지/비디오/오디오/PDF 등 인라인 미리보기가 안전·유용한 타입은 false.
 */
const DANGEROUS_INLINE_MIME_PREFIXES = ['text/html', 'application/xhtml', 'image/svg'];
const DANGEROUS_INLINE_MIME_EXACT = new Set<string>([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
]);

export function requiresAttachmentDisposition(mime: string): boolean {
  const m = mime.toLowerCase();
  if (DANGEROUS_INLINE_MIME_EXACT.has(m)) return true;
  return DANGEROUS_INLINE_MIME_PREFIXES.some((p) => m.startsWith(p));
}
