import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isSafeLinkUrl, type MessageEmbedDto } from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { Icon } from '../../design-system/primitives';

/**
 * task-045 iter6: link unfurl `.qf-embed` 카드 컴포넌트. S60 (D11): 서버 push embed 소비
 * 모드 추가.
 *
 * 두 모드:
 *   1. **server embed**(S60 권장): `embed` prop(MessageEmbedDto)을 받으면 BE 가 비동기
 *      unfurl 해 push 한 카드를 그대로 렌더한다. 이미지는 imageProxyUrl(`/links/embed-image/:id`)
 *      백엔드 프록시 경로로만 노출한다(presigned 직접 노출 금지 — FR-RC21). suppressedAt 이
 *      있으면 hide(서버가 보통 suppress 를 [] 로 빼지만 방어).
 *   2. **lazy fetch**(레거시 폴백): `url` prop 만 받으면 종전대로 `/links/preview` 를 lazy
 *      fetch 한다(서버가 아직 embed 를 push 하지 않은 메시지 호환).
 *
 * statusCode 200 + (title || description) 가 있으면 카드 표시. 그 외엔 null(부모가 URL 만 노출).
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

type Props = {
  url?: string;
  embed?: MessageEmbedDto;
  /**
   * 072-N0 (감사 FR-RC08 / FR-AM-16): viewer 가 이 카드를 억제(suppress)할 수 있는지.
   * 작성자 또는 MANAGE_MESSAGES 권한자만 true. 부모(MessageItem)가 게이트를 평가해 넘긴다.
   * true + onSuppress 가 함께 전달될 때만 카드 우상단 ✕('embed 숨기기')가 노출된다.
   */
  canSuppress?: boolean;
  /**
   * 072-N0: ✕ 클릭 시 호출. 부모가 useSuppressEmbed 로 bound 한 mutation 을 넘긴다
   * (msgId/embedId 는 부모가 바인딩). 서버 성공 시 message:embed_updated 가 카드를
   * 영구 제거하고, 본 컴포넌트는 즉시 낙관적 hide 만 담당한다.
   */
  onSuppress?: () => void;
};

/** S60: 서버 push embed 카드(`.qf-embed`). 이미지는 백엔드 프록시 경로로만 노출. */
function ServerEmbedCard({
  embed,
  canSuppress,
  onSuppress,
}: {
  embed: MessageEmbedDto;
  canSuppress?: boolean;
  onSuppress?: () => void;
}): JSX.Element | null {
  // 072-N0: ✕ 클릭 시 서버 fanout(message:embed_updated) 도착 전까지의 낙관적 hide.
  const [dismissed, setDismissed] = useState(false);
  if (embed.suppressedAt) return null;
  if (dismissed) return null;
  if (!embed.title && !embed.description && !embed.imageProxyUrl) return null;
  // S02 보안 선례: link 노드와 동일한 스킴 검증을 카드 제목 href 에도 적용한다.
  const titleHref = isSafeLinkUrl(embed.url) ? embed.url : null;
  // S60 fix (reviewer MAJOR-1): 이미지가 있으면 DS 의 `qf-embed--image` 수식자를 붙인다.
  // 수식자 없는 `.qf-embed` 안의 `.qf-embed__thumb` 는 components.css 의 width:100%·max-width
  // 규칙이 미적용이라 OG 이미지(예 1200x630)가 카드 폭을 넘어 overflow 한다. DS 4파일은
  // 수정하지 않고, 앱 className 으로만 기존 DS 규칙(`.qf-embed--image .qf-embed__thumb`)을 켠다.
  // 072-N0: ✕ 버튼은 position:absolute 라 DS .qf-embed__dismiss 규칙이 요구하는
  // position:relative 를 앱 클래스(relative)로 켠다(DS 4파일 무수정).
  const showDismiss = Boolean(canSuppress && onSuppress);
  const rootClass = [
    'qf-embed',
    embed.imageProxyUrl ? 'qf-embed--image' : '',
    showDismiss ? 'relative' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={rootClass} data-testid={`link-embed-${embed.id}`}>
      {showDismiss ? (
        <button
          type="button"
          className="qf-embed__dismiss"
          aria-label="embed 숨기기"
          data-testid={`link-embed-dismiss-${embed.id}`}
          onClick={() => {
            setDismissed(true);
            onSuppress?.();
          }}
        >
          <Icon name="x" size="sm" />
        </button>
      ) : null}
      {embed.siteName ? <div className="qf-embed__site">{embed.siteName}</div> : null}
      {embed.title ? (
        titleHref ? (
          <a className="qf-embed__title" href={titleHref} target="_blank" rel="noopener noreferrer">
            {embed.title}
          </a>
        ) : (
          <div className="qf-embed__title">{embed.title}</div>
        )
      ) : null}
      {embed.description ? <div className="qf-embed__desc">{embed.description}</div> : null}
      {embed.imageProxyUrl ? (
        <img className="qf-embed__thumb" src={embed.imageProxyUrl} alt="" loading="lazy" />
      ) : null}
    </div>
  );
}

export function LinkPreview({ url, embed, canSuppress, onSuppress }: Props): JSX.Element | null {
  // S60: 서버가 push 한 embed 가 있으면 그것을 우선 렌더한다(lazy fetch 안 함). 분기를
  // 별도 컴포넌트로 나눠 useQuery 가 조건부 훅이 되지 않게 한다(rules-of-hooks).
  // 072-N0: suppress ✕ 는 서버 embed(고유 id 존재) 에만 의미가 있어 ServerEmbedCard 에만 배선.
  if (embed)
    return <ServerEmbedCard embed={embed} canSuppress={canSuppress} onSuppress={onSuppress} />;
  if (!url) return null;
  return <LazyLinkPreview url={url} />;
}

/** task-045: `/links/preview` lazy fetch 폴백(서버가 아직 embed 를 push 안 한 호환). */
function LazyLinkPreview({ url }: { url: string }): JSX.Element | null {
  const effectiveUrl = url;
  const q = useQuery<Preview>({
    queryKey: ['links', 'preview', effectiveUrl],
    queryFn: () => fetchPreview(effectiveUrl),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
    enabled: effectiveUrl.length > 0,
  });

  if (q.isLoading) {
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

  const titleHref = isSafeLinkUrl(p.url) ? p.url : null;

  return (
    <div className="qf-embed" data-testid={`link-preview-${effectiveUrl}`}>
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
