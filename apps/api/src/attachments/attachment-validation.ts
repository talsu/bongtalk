import {
  ALLOWED_MIME_KIND,
  BLOCKED_EXTENSIONS,
  ZIP_DISGUISE_EXTENSIONS,
  UPLOAD_TTL_DEFAULT_SEC,
  UPLOAD_TTL_MEDIUM_SEC,
  UPLOAD_TTL_LARGE_SEC,
  UPLOAD_TTL_MEDIUM_THRESHOLD,
  UPLOAD_TTL_LARGE_THRESHOLD,
} from '@qufox/shared-types';

/**
 * S54 (D11 / FR-AM-05/06) — 첨부 검증 pure helpers. 서비스와 unit 테스트가 공유한다.
 */

/**
 * filename 에서 소문자 확장자(점 제외)를 추출한다. 점이 없거나 마지막 점이 맨 끝이면
 * null(확장자 없음). "archive.tar.gz" → "gz". 쿼리/경로 잔재가 없는 순수 파일명을 가정한다.
 */
export function extractExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  // 확장자에 허용되지 않는 문자가 섞이면(경로/널바이트 등) 신뢰하지 않는다.
  return /^[a-z0-9]{1,20}$/.test(ext) ? ext : null;
}

/** FR-AM-05: 차단 확장자(실행/스크립트/디스크 이미지) 여부. */
export function isBlockedExtension(ext: string | null): boolean {
  if (!ext) return false;
  return BLOCKED_EXTENSIONS.includes(ext);
}

/**
 * FR-AM-05 교차검증: declared mime=application/zip 인데 extension 이 실행 가능 아카이브
 * (jar/apk/ipa)면 true(거부). zip 으로 위장한 실행 아카이브를 막는다. mime 이 zip 이
 * 아니면 무관하게 false.
 */
export function isZipExtensionMismatch(mime: string, ext: string | null): boolean {
  if (mime.toLowerCase() !== 'application/zip') return false;
  if (!ext) return false;
  return ZIP_DISGUISE_EXTENSIONS.includes(ext);
}

/** FR-AM-06: 허용 MIME → kind. 화이트리스트 밖이면 null. */
export function kindForMime(mime: string): 'IMAGE' | 'VIDEO' | 'FILE' | null {
  return ALLOWED_MIME_KIND[mime.toLowerCase()] ?? null;
}

/**
 * FR-AM-03: presigned TTL 크기 분기(초). 기본 15분 / 30MB+ 30분 / 80MB+ 60분.
 * 큰 파일일수록 느린 업로드를 허용하기 위해 더 긴 TTL 을 준다.
 */
export function ttlForSize(sizeBytes: number): number {
  if (sizeBytes >= UPLOAD_TTL_LARGE_THRESHOLD) return UPLOAD_TTL_LARGE_SEC;
  if (sizeBytes >= UPLOAD_TTL_MEDIUM_THRESHOLD) return UPLOAD_TTL_MEDIUM_SEC;
  return UPLOAD_TTL_DEFAULT_SEC;
}
