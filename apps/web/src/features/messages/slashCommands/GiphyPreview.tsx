import { useState } from 'react';
import { Icon } from '../../../design-system/primitives';
import { cn } from '../../../lib/cn';
import { searchGiphy } from './api';
import { useGiphyPreviewStore } from './useGiphyPreview';

/** 컴포저 textarea 로 포커스를 되돌린다(Send/Cancel 로 프리뷰가 언마운트된 뒤 호출). */
function focusComposer(): void {
  document.getElementById('msg-input')?.focus();
}

/**
 * S81b (D15 / FR-SC-07) — /giphy 발신자 전용 GIF 프리뷰(채널 미게시).
 *
 * EphemeralMessage 와 시각 일관된 "나만 보임" 인라인 카드로, GIF 썸네일 + GIPHY attribution
 * (필수 — GIPHY 약관) + [Shuffle][Send][Cancel] 버튼을 제공한다.
 *   - Shuffle → POST .../giphy/search { keyword, offset: 현재+1 } → 프리뷰 교체.
 *   - Send    → onSend(gifUrl) 로 호출자(MessageComposer)가 일반 메시지 게시(기존 send 경로
 *               재사용 — 게시된 URL 은 S60 unfurl 이 인라인 렌더). 게시 후 프리뷰 제거.
 *   - Cancel  → 프리뷰 로컬 제거(서버 호출 없음).
 *
 * 워크스페이스/채널 컨텍스트는 Shuffle 의 REST 호출에 필요하다. workspaceId=null(Global DM)은
 * /giphy 실행이 비활성이라(MessageComposer 가 폴백) 이 컴포넌트가 마운트되지 않는다.
 */
export function GiphyPreview({
  workspaceId,
  channelId,
  onSend,
  announce,
}: {
  workspaceId: string;
  channelId: string;
  onSend: (gifUrl: string) => void;
  announce?: (msg: string) => void;
}): JSX.Element | null {
  // reviewer HIGH-1 (S81b 리뷰): store 액션을 직접 안정 참조로 구독한다(useGiphyPreview 훅의
  // 매-렌더 새 클로저가 cleanup/콜백 의존성을 흔들지 않게). preview 만 채널별로 선택 구독한다.
  const preview = useGiphyPreviewStore((s) => s.byChannel[channelId] ?? null);
  const setPreview = useGiphyPreviewStore((s) => s.set);
  const clearPreview = useGiphyPreviewStore((s) => s.clear);
  const [shuffling, setShuffling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // reviewer LOW-1 (S81b 리뷰): 썸네일 로드 실패 시 인라인 안내로 폴백한다(깨진 이미지 숨김).
  const [thumbBroken, setThumbBroken] = useState(false);

  if (!preview) return null;

  const handleShuffle = (): void => {
    if (shuffling) return;
    setShuffling(true);
    setError(null);
    setThumbBroken(false);
    const nextOffset = preview.offset + 1;
    void searchGiphy({ workspaceId, channelId, keyword: preview.keyword, offset: nextOffset })
      .then((res) => {
        setPreview({
          channelId,
          gifUrl: res.gifUrl,
          gifThumbUrl: res.gifThumbUrl,
          title: res.title,
          keyword: preview.keyword,
          offset: nextOffset,
        });
        announce?.('다른 GIF 를 불러왔습니다');
      })
      .catch(() => {
        // a11y HIGH-3 + reviewer MED-1 (S81b 리뷰): raw err.message(Zod blob 등)를 노출하지
        // 않고 고정 친화 문구만 보여준다. SR 통지는 아래 role="alert" 가 담당하므로 여기서
        // announce 를 중복 호출하지 않는다(이중 낭독 방지).
        setError('GIF 를 더 불러오지 못했습니다');
      })
      .finally(() => setShuffling(false));
  };

  const handleSend = (): void => {
    // a11y HIGH-2 (S81b 리뷰): clear() 로 카드가 언마운트되기 전에 전송 성공을 SR 에 통지한다.
    onSend(preview.gifUrl);
    announce?.('GIF 를 채널에 보냈습니다');
    clearPreview(channelId);
    // a11y HIGH(focus): 언마운트 후 컴포저 textarea 로 포커스를 되돌린다.
    focusComposer();
  };

  const handleCancel = (): void => {
    clearPreview(channelId);
    focusComposer();
  };

  return (
    <div
      data-testid="giphy-preview"
      // a11y BLK-1 (S81b 리뷰): EphemeralList 와 일관되게 group + aria-label 로 "나만 보임"
      // 맥락을 노출한다.
      role="group"
      aria-label="GIF 미리보기 — 나만 보임"
      // EphemeralMessage 와 동일 시각 토큰(bg-bg-subtle 유효) — 발신자 전용 인라인 카드.
      className={cn(
        'qf-giphy-preview group flex flex-col gap-2 rounded-md bg-bg-subtle px-3 py-2',
        'border border-border-subtle text-sm',
      )}
    >
      <div className="flex items-center gap-2 text-text-muted">
        <Icon name="gif" className="shrink-0" />
        <span className="text-xs font-medium">나만 보임 · GIF 미리보기</span>
      </div>

      {thumbBroken ? (
        // reviewer LOW-1 (S81b 리뷰): 썸네일 로드 실패 시 깨진 img 대신 인라인 안내를 보여준다.
        <span data-testid="giphy-preview-thumb-error" className="text-xs text-text-muted">
          GIF 미리보기를 불러오지 못했습니다
        </span>
      ) : (
        <img
          src={preview.gifThumbUrl}
          alt={preview.title || `"${preview.keyword}" GIF`}
          data-testid="giphy-preview-image"
          // perf MINOR (S81b 리뷰): 디코딩을 비동기로 돌려 메인 스레드 블로킹을 줄인다.
          decoding="async"
          // reviewer LOW-1 (S81b 리뷰): 깨진 썸네일 URL 이면 인라인 에러로 폴백한다.
          onError={() => setThumbBroken(true)}
          // DS 토큰 기반 라운드 + 최대폭(인라인 카드). 서버 리사이즈 없이 CSS 다운스케일.
          className="max-w-[var(--giphy-preview-max-w,320px)] rounded-md"
        />
      )}

      {error ? (
        // a11y HIGH-3 (S81b 리뷰): role="alert" 로 SR 에 즉시 통지, 색은 Tailwind danger 키.
        <span data-testid="giphy-preview-error" role="alert" className="text-danger">
          {error}
        </span>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        {/* GIPHY attribution — 필수(GIPHY 약관). 텍스트로 출처를 명시한다. */}
        <span data-testid="giphy-attribution" className="text-xs text-text-muted">
          Powered By GIPHY
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleShuffle}
            disabled={shuffling}
            // a11y BLK-2 (S81b 리뷰): 로딩 중을 SR 에 노출(disabled 는 유지). a11y MAJ-3:
            // 가시 텍스트("셔플")가 접근성 이름이 되도록 aria-label 은 두지 않는다(label-in-name 일치).
            aria-busy={shuffling}
            data-testid="giphy-shuffle"
            className="qf-btn qf-btn--ghost qf-btn--sm"
          >
            <Icon name="refresh" />
            <span>셔플</span>
          </button>
          <button
            type="button"
            onClick={handleSend}
            aria-label="이 GIF 보내기"
            data-testid="giphy-send"
            className="qf-btn qf-btn--primary qf-btn--sm"
          >
            <Icon name="send" />
            <span>보내기</span>
          </button>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="GIF 미리보기 닫기"
            data-testid="giphy-cancel"
            className="qf-btn qf-btn--ghost qf-btn--sm"
          >
            <Icon name="x" />
            {/* a11y MAJ-1 (S81b 리뷰): 다른 버튼과 가시 일관 — sr-only 라벨을 함께 둔다. */}
            <span className="sr-only">닫기</span>
          </button>
        </div>
      </div>
    </div>
  );
}
