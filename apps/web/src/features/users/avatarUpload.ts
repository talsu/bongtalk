/**
 * S73 (D14 / FR-PS-01): presigned PUT 으로 아바타 blob 을 MinIO 에 직접 올린다.
 *
 * presign 으로 받은 URL 은 MinIO 를 직접 가리키므로 apiRequest(=API 서버) 가 아니라
 * 순수 fetch 로 PUT 한다. Content-Type 은 presign 시 선언한 mime 과 일치해야 한다
 * (서버 finalize 의 magic-byte 교차검증과 정합). 커스텀 이모지 업로드(emojis/api.ts)와
 * 동일한 패턴.
 */
export async function uploadAvatarBlob(putUrl: string, file: File): Promise<void> {
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) {
    throw new Error(`avatar upload failed: ${res.status} ${res.statusText}`);
  }
}
