/**
 * S56 (D11 / FR-AM-01/02/21/22) — 첨부 업로드 에러 → 사용자 토스트 매핑.
 *
 * 백엔드(S54/S55)가 내려보내는 ErrorCode(`apps/api/src/common/errors/error-code.enum.ts`)
 * 또는 MinIO 직접 업로드(2단계)의 HTTP 상태(403/413)를 폴라이트 한국어 토스트
 * 문구로 환산합니다. 순수 함수라 단위 테스트가 모든 분기를 구동할 수 있습니다.
 *
 * apiRequest / apiRequestRaw 가 throw 하는 Error 에는 `errorCode`(서버 enum) 와
 * `status`(HTTP) 가 붙습니다(`lib/api.ts` bubbleError). MinIO XHR 실패는
 * UploadHttpError 로 status 만 싣습니다.
 */

/** MinIO 직접 업로드(2단계) XHR 실패. status 만 의미가 있습니다. */
export class UploadHttpError extends Error {
  constructor(
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `upload failed: ${status}`);
    this.name = 'UploadHttpError';
  }
}

/** 사용자에게 노출할 토스트 모양(notification-store.push 의 부분집합). */
export interface UploadToast {
  title: string;
  body: string;
}

/**
 * 에러 → 토스트. `fileName` 은 컨텍스트로 body 에 덧붙입니다(여러 파일 동시 업로드
 * 시 어느 파일이 실패했는지 구분). 알 수 없는 에러는 generic 폴백 문구입니다.
 */
export function uploadErrorToast(err: unknown, fileName?: string): UploadToast {
  const code = errorCodeOf(err);
  const status = statusOf(err);
  const suffix = fileName ? ` (${fileName})` : '';

  // 1) 서버 도메인 ErrorCode 우선.
  switch (code) {
    case 'ATTACHMENT_EXTENSION_BLOCKED':
      return {
        title: '허용되지 않는 파일 형식',
        body: `보안상 업로드할 수 없는 파일 형식입니다.${suffix}`,
      };
    case 'MIME_MISMATCH':
      return {
        title: '파일 형식 불일치',
        body: `파일 내용과 형식이 일치하지 않아 업로드할 수 없습니다.${suffix}`,
      };
    case 'ATTACHMENT_MIME_REJECTED':
      return {
        title: '지원하지 않는 파일 형식',
        body: `지원하지 않는 파일 형식입니다.${suffix}`,
      };
    case 'ATTACHMENT_COUNT_EXCEEDED':
      return {
        title: '첨부 개수 초과',
        body: '한 메시지에 첨부할 수 있는 파일 수를 초과했습니다.',
      };
    case 'UPLOAD_RATE_LIMIT':
      return {
        title: '업로드 한도 초과',
        body: '업로드 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
      };
    case 'FILE_UPLOAD_DISABLED':
      return {
        title: '업로드 비활성화',
        body: '이 채널에서는 파일 업로드가 비활성화되어 있습니다.',
      };
    case 'ATTACHMENT_SESSION_EXPIRED':
      return {
        title: '업로드 세션 만료',
        body: `업로드 시간이 만료되었습니다. 다시 시도해 주세요.${suffix}`,
      };
    default:
      break;
  }

  // 2) MinIO 직접 업로드(2단계) HTTP 상태.
  if (status === 413) {
    return {
      title: '파일이 너무 큼',
      body: `파일 크기가 허용 한도를 초과했습니다.${suffix}`,
    };
  }
  if (status === 403) {
    return {
      title: '업로드 거부됨',
      body: `업로드 권한이 없거나 세션이 만료되었습니다. 다시 시도해 주세요.${suffix}`,
    };
  }

  // 3) 폴백.
  return {
    title: '업로드 실패',
    body: `파일을 업로드하지 못했습니다. 다시 시도해 주세요.${suffix}`,
  };
}

function errorCodeOf(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'errorCode' in err) {
    const v = (err as { errorCode?: unknown }).errorCode;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof UploadHttpError) return err.status;
  if (err && typeof err === 'object' && 'status' in err) {
    const v = (err as { status?: unknown }).status;
    return typeof v === 'number' ? v : undefined;
  }
  return undefined;
}
