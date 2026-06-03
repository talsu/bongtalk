import { useEffect, useState } from 'react';
import { fetchAttachmentObjectUrl, type ProxyVariant } from './attachmentSrc';

/**
 * 인증 fetch → objectURL 로 미리보기 src 를 얻습니다(S56 에서 AttachmentsList 안에
 * 있던 훅을 S58 에서 모듈로 분리 — ImageMosaicGrid 의 셀도 동일 로직을 재사용합니다).
 *
 * S56 fix-forward (perf CRITICAL): objectURL 의 수명은 attachmentSrc 의 모듈 LRU 캐시가
 * 소유합니다. 따라서 언마운트/재마운트(채널 전환) 시 revoke 하지 않고(revoke 하면 캐시에
 * 남은 동일 url 이 깨집니다), 캐시 hit 시 fetch 가 생략돼 채널 재진입마다 50장 재다운로드
 * 하던 회귀를 막습니다. revoke 는 LRU eviction 시에만 캐시 내부에서 일어납니다.
 */
export function useProxyObjectUrl(
  id: string,
  variant: ProxyVariant,
): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let aborted = false;
    setError(false);
    setUrl(null);
    fetchAttachmentObjectUrl(id, variant)
      .then((u) => {
        if (aborted) return;
        setUrl(u);
      })
      .catch(() => {
        if (!aborted) setError(true);
      });
    return () => {
      // url revoke 안 함 — 캐시가 수명을 소유(채널 재진입 재fetch 회피).
      aborted = true;
    };
  }, [id, variant]);
  return { url, error };
}
