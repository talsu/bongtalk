import { isSafeLinkUrl, type RichEmbed as RichEmbedData } from '@qufox/shared-types';

/**
 * S84b (D16 / FR-RC12): 봇/웹훅 rich embed 카드(`.qf-embed` 기반).
 *
 * Discord 스타일 embed 를 렌더한다 — color bar(좌측 border, content 색이라 인라인 허용:
 * Avatar seed 색 선례) · author(아이콘+이름, url 링크) · linked title · description ·
 * fields grid(inline 은 한 행에 모음) · image/thumbnail · footer(텍스트+아이콘+timestamp).
 *
 * 보안: 모든 URL 은 BE 스키마가 이미 http(s) 로 제한했지만, 렌더 href/src 에도
 * `isSafeLinkUrl` 을 한 번 더 적용해(방어적 deep-defense · ServerEmbedCard 선례) 안전치
 * 않은 URL 은 링크/이미지를 떨군다. DS 4파일은 수정하지 않고 Tailwind DS 토큰으로 합성한다.
 */
function safeUrl(u: string | undefined): string | null {
  return u && isSafeLinkUrl(u) ? u : null;
}

function RichEmbedCard({ embed, index }: { embed: RichEmbedData; index: number }): JSX.Element {
  const titleHref = safeUrl(embed.url);
  const authorUrl = safeUrl(embed.author?.url);
  const authorIcon = safeUrl(embed.author?.icon_url);
  const imageUrl = safeUrl(embed.image?.url);
  const thumbUrl = safeUrl(embed.thumbnail?.url);
  const footerIcon = safeUrl(embed.footer?.icon_url);
  // color 는 content 색이라 인라인 style 허용(DS 토큰 아님 · Avatar seed 선례).
  const colorStyle = embed.color ? { borderLeftColor: embed.color } : undefined;

  return (
    <div
      className="qf-embed"
      style={colorStyle}
      data-testid={`rich-embed-${index}`}
      data-embed-color={embed.color ?? undefined}
    >
      {embed.author?.name ? (
        <div className="flex items-center gap-[var(--s-2)]">
          {authorIcon ? (
            <img
              src={authorIcon}
              alt=""
              loading="lazy"
              className="h-[var(--s-6)] w-[var(--s-6)] rounded-full"
            />
          ) : null}
          {authorUrl ? (
            <a
              className="text-[length:var(--fs-13)] font-semibold text-text-default"
              href={authorUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {embed.author.name}
            </a>
          ) : (
            <span className="text-[length:var(--fs-13)] font-semibold text-text-default">
              {embed.author.name}
            </span>
          )}
        </div>
      ) : null}

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

      {embed.fields && embed.fields.length > 0 ? (
        <div className="mt-[var(--s-2)] flex flex-wrap gap-[var(--s-2)]">
          {embed.fields.map((f, i) => (
            <div
              key={`field-${i}`}
              className={f.inline ? 'flex-1 basis-[30%]' : 'w-full basis-full'}
              data-testid={`rich-embed-${index}-field-${i}`}
            >
              <div className="text-[length:var(--fs-13)] font-semibold text-text-default">
                {f.name}
              </div>
              <div className="text-[length:var(--fs-13)] text-text-secondary">{f.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          loading="lazy"
          className="mt-[var(--s-2)] max-w-[var(--s-12)] rounded-[var(--r-md)]"
        />
      ) : null}

      {imageUrl ? (
        // DS `.qf-embed--image` 래퍼가 max-width(400px) + overflow:hidden 를, 내부
        // `.qf-embed__thumb` 가 width:100% + radius 를 제공한다(LinkPreview 선례 · DS 4파일
        // 미수정 · raw px 회피). 카드 본문과 간격은 mt-[var(--s-2)] 로 준다.
        <div className="qf-embed--image mt-[var(--s-2)]">
          <img className="qf-embed__thumb" src={imageUrl} alt="" loading="lazy" />
        </div>
      ) : null}

      {embed.footer?.text || embed.timestamp ? (
        <div className="mt-[var(--s-2)] flex items-center gap-[var(--s-2)] text-[length:var(--fs-11)] text-text-muted">
          {footerIcon ? (
            <img
              src={footerIcon}
              alt=""
              loading="lazy"
              className="h-[var(--s-5)] w-[var(--s-5)] rounded-full"
            />
          ) : null}
          {embed.footer?.text ? <span>{embed.footer.text}</span> : null}
          {embed.footer?.text && embed.timestamp ? <span aria-hidden>•</span> : null}
          {embed.timestamp ? (
            <time dateTime={embed.timestamp}>{formatEmbedTimestamp(embed.timestamp)}</time>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** footer timestamp 를 사람이 읽는 로컬 표기로(파싱 실패 시 원문 유지). */
function formatEmbedTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * 메시지의 rich embed 배열을 렌더한다. 빈/누락 배열은 null(렌더 없음).
 * BE 가 빈 embed 를 이미 걸렀지만, 방어적으로 isRenderable 가드 없이 그대로 그린다
 * (각 카드가 내부적으로 필드 유무로 분기).
 */
export function RichEmbeds({ embeds }: { embeds?: RichEmbedData[] }): JSX.Element | null {
  if (!embeds || embeds.length === 0) return null;
  return (
    <>
      {embeds.map((e, i) => (
        <RichEmbedCard key={`rich-embed-${i}`} embed={e} index={i} />
      ))}
    </>
  );
}
