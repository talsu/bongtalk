import { useState } from 'react';

/**
 * S48 (D06 / FR-MN-10): 키워드 알림 태그 입력.
 *
 * 최대 25개 등록(KEYWORD_MAX_COUNT). 26번째 추가 시도 시 onLimitExceeded 로 토스트를
 * 위임한다(서버도 KEYWORD_LIMIT_EXCEEDED 400 으로 권위 차단 — 클라는 선제 가드).
 * 중복(대소문자 무관)은 무시, 삭제 가능. Enter/콤마로 확정. 실제 키워드 스캔은
 * 미구현(서버 컬럼 저장만 — TODO(mention-scan: MentionRecord·S45 인프라 결정 후)).
 *
 * DS 토큰 + 기존 qf-* 만 사용(raw hex/px 0, 신규 DS 클래스 0).
 */
export const KEYWORD_MAX_COUNT = 25;

export interface KeywordsInputProps {
  keywords: string[];
  onChange: (_next: string[]) => void;
  onLimitExceeded: () => void;
  disabled?: boolean;
}

export function KeywordsInput({
  keywords,
  onChange,
  onLimitExceeded,
  disabled,
}: KeywordsInputProps): JSX.Element {
  const [draft, setDraft] = useState('');

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    // 대소문자 무관 중복 방지.
    if (keywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) {
      setDraft('');
      return;
    }
    if (keywords.length >= KEYWORD_MAX_COUNT) {
      onLimitExceeded();
      return;
    }
    onChange([...keywords, trimmed]);
    setDraft('');
  };

  const remove = (kw: string): void => {
    onChange(keywords.filter((k) => k !== kw));
  };

  const atLimit = keywords.length >= KEYWORD_MAX_COUNT;

  return (
    <div className="flex flex-col gap-[var(--s-3)]" data-testid="keywords-input">
      {keywords.length > 0 && (
        <ul className="flex flex-wrap gap-[var(--s-2)]" data-testid="keywords-list">
          {keywords.map((kw) => (
            <li
              key={kw}
              className="inline-flex items-center gap-[var(--s-2)] rounded-[var(--r-md)] bg-bg-subtle px-[var(--s-3)] py-[var(--s-1)] text-[length:var(--fs-12)] text-foreground"
              data-testid={`keyword-tag-${kw}`}
            >
              <span>{kw}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(kw)}
                data-testid={`keyword-remove-${kw}`}
                aria-label={`키워드 "${kw}" 삭제`}
                className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-[var(--s-2)]">
        <input
          type="text"
          value={draft}
          disabled={disabled || atLimit}
          placeholder={
            atLimit ? `최대 ${KEYWORD_MAX_COUNT}개까지 등록할 수 있습니다` : '키워드 입력 후 Enter'
          }
          data-testid="keyword-draft"
          aria-label="키워드 추가"
          className="qf-input w-full"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(draft);
            }
          }}
        />
        <span
          className="shrink-0 text-[length:var(--fs-12)] text-text-muted"
          data-testid="keyword-count"
        >
          {keywords.length}/{KEYWORD_MAX_COUNT}
        </span>
      </div>
      <p className="text-[length:var(--fs-12)] text-text-muted">
        등록한 키워드가 포함된 메시지에 알림을 받습니다. 스레드 댓글은 제외됩니다.
      </p>
    </div>
  );
}
