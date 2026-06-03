import { apiRequest } from '../../lib/api';
import type {
  CompleteSessionItem,
  CompleteUploadRequest,
  UploadSession,
  UploadUrlRequest,
  UploadUrlResponse,
} from '@qufox/shared-types';
import { UploadHttpError } from './uploadErrors';

/**
 * S56 (D11 / FR-AM-03) — 첨부 3단계 업로드 클라이언트.
 *
 *   1) POST /workspaces/:wsId/channels/:chid/attachments/upload-url
 *      → { sessions:[{ sessionId, storageKey, expiresAt, upload:{method,url,fields} }] }
 *   2) MinIO 직접 업로드(XHR — fetch 는 upload progress 미지원):
 *        method==='POST' → FormData(fields 순서대로 append, 마지막에 file) → XHR POST
 *        method==='PUT'  → XHR PUT body=file, Content-Type=file.type
 *      onprogress 콜백으로 0~100 진행률을 전달합니다.
 *   3) POST /workspaces/:wsId/channels/:chid/attachments/complete
 *      { targetChannelId | messageId, sessions:[{ sessionId, width?, height?, altText?, isSpoiler?, sortOrder }] }
 *      → { attachmentIds }
 *
 * DM(wsId=null) 채널은 채널 nested 첨부 엔드포인트가 워크스페이스 스코프에만
 * 존재하므로(S54 계약) wsId 가 null 이면 호출하지 않습니다 — 호출자가 게이트합니다.
 */

function attachmentsBase(wsId: string, channelId: string): string {
  return `/workspaces/${wsId}/channels/${channelId}/attachments`;
}

/** 1단계: 업로드 세션 발급(파일 1개당 count=1). */
export async function requestUploadUrl(
  wsId: string,
  channelId: string,
  input: UploadUrlRequest,
): Promise<UploadUrlResponse> {
  return apiRequest<UploadUrlResponse>(`${attachmentsBase(wsId, channelId)}/upload-url`, {
    method: 'POST',
    body: input,
  });
}

/** 3단계: 업로드 완료 → Attachment 승격 + attachmentIds 반환. */
export async function completeUpload(
  wsId: string,
  channelId: string,
  input: CompleteUploadRequest,
): Promise<{ attachmentIds: string[] }> {
  return apiRequest<{ attachmentIds: string[] }>(`${attachmentsBase(wsId, channelId)}/complete`, {
    method: 'POST',
    body: input,
  });
}

/**
 * 2단계: MinIO 직접 업로드(XHR). method 분기:
 *   POST → FormData(presigned POST policy fields + file)
 *   PUT  → 본문 = file, Content-Type = file.type
 * onProgress 는 0~100 정수를 전달합니다(lengthComputable 아니면 호출 안 함).
 * 2xx 외 응답/네트워크 에러는 UploadHttpError(status) 로 reject 합니다.
 */
export function uploadToStorage(
  upload: UploadSession['upload'],
  file: File,
  onProgress?: (percent: number) => void,
  // 테스트 주입용(기본은 전역 XMLHttpRequest). vi.fn() 으로 교체합니다.
  XhrCtor: typeof XMLHttpRequest = XMLHttpRequest,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XhrCtor();
    const contentType = file.type || 'application/octet-stream';

    // S56 fix-forward (perf serious — 진행률 setState 폭주): XHR onprogress 는
    // 업로드 중 수십~수백 회 발화한다. 정수 % 가 실제로 바뀐 경우에만 콜백을
    // 호출해 호출자의 setState(전체 배열 map) 빈도를 100회 이하로 제한한다.
    let lastPercent = -1;
    const emit = (percent: number): void => {
      if (!onProgress) return;
      if (percent === lastPercent) return;
      lastPercent = percent;
      onProgress(percent);
    };

    xhr.upload.onprogress = (e: ProgressEvent): void => {
      if (!onProgress) return;
      if (e.lengthComputable && e.total > 0) {
        emit(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = (): void => {
      // MinIO presigned POST 는 성공 시 204(또는 201), PUT 은 200. 2xx 외는 거부.
      if (xhr.status >= 200 && xhr.status < 300) {
        emit(100);
        resolve();
      } else {
        reject(new UploadHttpError(xhr.status, `storage upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = (): void => {
      // 네트워크/CORS 에러는 status 0 — 폴백 토스트로 흐릅니다.
      reject(new UploadHttpError(xhr.status || 0, 'storage upload network error'));
    };
    xhr.onabort = (): void => {
      reject(new UploadHttpError(0, 'storage upload aborted'));
    };

    if (upload.method === 'POST') {
      const form = new FormData();
      // presigned POST 는 policy/signature 필드를 먼저, file 을 **마지막**에 append
      // 해야 MinIO 가 정책 검증을 수행합니다(S3 createPresignedPost 규약).
      for (const [k, v] of Object.entries(upload.fields)) {
        form.append(k, v);
      }
      form.append('file', file);
      xhr.open('POST', upload.url);
      xhr.send(form);
    } else {
      xhr.open('PUT', upload.url);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.send(file);
    }
  });
}

/** complete 요청 body 를 만들기 위한 per-file 메타(드래그 재정렬 sortOrder 는 인덱스). */
export type CompleteSessionInput = CompleteSessionItem;
