import { useQuery } from '@tanstack/react-query';
import { isSafeLinkUrl } from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';

/**
 * task-045 iter6: link unfurl `.qf-embed` 카드 컴포넌트.
 *
 * URL 1개에 대해 BE `/links/preview` 를 lazy fetch 하고, og:* 메타가
 * 도착하면 DS `.qf-embed` 클래스로 카드 렌더. 실패 / 빈 메타 시 hide
 * (URL 만 부모가 표시).
 *
 * react-query staleTime 30 분 — BE Redis TTL 1h 보다 짧게 두어 새로고침
 * 시 freshness 회복. cacheTime 1h.
 *
 * statusCode 200 + (title || description) 가 있으면 카드 표시. 그 외엔
 * null 반환 — 부모는 URL 링크만 노출.
 */

type Preview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  statusCode: number;
  fetchedAt: string;
};

function fetchPreview(url: string): Promise<Preview> {
  return apiRequest(`/links/preview?url=${encodeURIComponent(url)}`);
}

type Props = { url: string };

export function LinkPreview({ url }: Props): JSX.Element | null {
  const q = useQuery<Preview>({
    queryKey: ['links', 'preview', url],
    queryFn: () => fetchPreview(url),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
  });

  if (q.isLoading) {
    // 빈 placeholder 카드 — 메시지 layout 안정화. 작은 박스 유지.
    return (
      <div
        className="qf-embed"
        data-testid="link-preview-loading"
        aria-busy="true"
        style={{ minHeight: 0 }}
      >
        <div className="qf-embed__site"> </div>
      </div>
    );
  }

  if (q.error || !q.data) return null;
  const p = q.data;
  if (p.statusCode < 200 || p.statusCode >= 300) return null;
  if (!p.title && !p.description) return null;

  // S02 보안(리뷰 HIGH): BE 가 ssrfGuard 통과 URL 을 돌려주지만, 렌더
  // 측에서도 link 노드와 동일한 2차 스킴 검증을 적용합니다. `p.url` 이
  // 비안전 스킴(또는 빈 값)이면 클릭 가능한 제목 대신 비링크 텍스트로
  // 폴백해 XSS/open-redirect 표면을 닫습니다.
  const titleHref = isSafeLinkUrl(p.url) ? p.url : null;

  return (
    <div className="qf-embed" data-testid={`link-preview-${url}`}>
      {p.siteName ? <div className="qf-embed__site">{p.siteName}</div> : null}
      {p.title ? (
        titleHref ? (
          <a className="qf-embed__title" href={titleHref} target="_blank" rel="noopener noreferrer">
            {p.title}
          </a>
        ) : (
          <div className="qf-embed__title">{p.title}</div>
        )
      ) : null}
      {p.description ? <div className="qf-embed__desc">{p.description}</div> : null}
    </div>
  );
}
