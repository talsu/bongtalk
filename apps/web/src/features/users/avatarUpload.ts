/**
 * S73 (D14 / FR-PS-01): presigned POST 로 아바타 blob 을 MinIO 에 직접 올린다.
 *
 * security HIGH#2 fix-forward: 종전 presigned PUT 은 클라가 임의 바이트/Content-Type 을
 * 올릴 수 있어 MinIO 가 업로드 시점에 크기/MIME 를 강제하지 못했다. presigned POST
 * (content-length-range + eq Content-Type 정책 조건 — S54 첨부 업로드 클라 패턴 재사용)로
 * 전환해 MinIO 가 정책을 강제한다. fields(policy/signature/key/Content-Type 등)를 먼저
 * append 하고 file 을 **마지막**에 append 해야 MinIO 가 정책 검증을 수행한다.
 *
 * presign 으로 받은 URL 은 MinIO 를 직접 가리키므로 apiRequest(=API 서버)가 아니라
 * 순수 fetch 로 POST 한다. finalize 의 magic-byte 사후검증은 그대로 유지된다(안전망).
 */
export async function uploadAvatarBlob(
  url: string,
  fields: Record<string, string>,
  file: File,
): Promise<void> {
  const form = new FormData();
  // presigned POST 규약: policy/signature 필드를 먼저, file 을 마지막에 append.
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v);
  }
  form.append('file', file);
  const res = await fetch(url, { method: 'POST', body: form });
  // MinIO presigned POST 는 성공 시 204(또는 201). 2xx 외는 거부.
  if (!res.ok) {
    throw new Error(`avatar upload failed: ${res.status} ${res.statusText}`);
  }
}
