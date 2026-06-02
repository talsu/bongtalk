import { useEffect, useMemo } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { usePins, useUnpinMessage } from './useMessages';
import { renderMessageContent } from './parseContent';

/**
 * S50 (D10 · FR-PS-03): 채널 핀 슬라이드인 패널.
 *
 * 채널 헤더 핀 아이콘 클릭으로 열리며, GET .../messages/pins 를 최신순(pinnedAt DESC,
 * 서버 보장)으로 표시한다. 각 항목은 2줄 클램프 + 작성자/시각 + 원본 메시지로 점프
 * 링크(onJump → MessageColumn 이 `?msg=` around 로드)를 가진다. 핀 해제 버튼도
 * 제공한다(useUnpinMessage). channel:pin_added/removed 이벤트가 usePins 캐시를
 * invalidate 해 패널이 실시간 갱신된다(FR-PS-03 "실시간 변경").
 *
 * 신규 DS 클래스 0 — 기존 qf-* 골격 + DS 토큰 유틸만 쓴다(raw hex/px 없음).
 * ActivityInboxPanel 의 role="complementary" aside 패턴과 정합.
 */
export function PinPanel({
  workspaceId,
  channelId,
  nameByUserId,
  onClose,
  onJump,
}: {
  workspaceId: string;
  channelId: string;
  nameByUserId: Map<string, string>;
  onClose: () => void;
  onJump: (messageId: string) => void;
}): JSX.Element {
  const query = usePins(workspaceId, channelId, true);
  const unpin = useUnpinMessage(workspaceId, channelId);
  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  // S50 review (a11y A-PP-02): Esc 로 패널을 닫는다(ThreadPanel 선례). 닫힌 뒤
  // 트리거(헤더 핀 버튼) 로의 포커스 복귀는 MessageColumn 의 onClose 가 담당
  // (A-PP-03). 비모달 complementary 패널이라 mount 시 포커스 이동은 하지 않는다
  // (ThreadPanel/ActivityInboxPanel 데스크톱 선례 — A-PP-01 의도적).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      id="pin-panel"
      aria-label="고정된 메시지"
      data-testid="pin-panel"
      // DS 데스크톱 사이드 패널 골격(qf-thread-panel: width + border-left + bg-chat)을
      // 재사용한다(신규 DS 클래스 0). ThreadPanel 선례.
      className="qf-thread-panel"
    >
      <header className="qf-topbar">
        <h2 className="qf-topbar__title flex items-center gap-[var(--s-2)]">
          <Icon name="pin" size="sm" />
          고정된 메시지
          {items.length > 0 ? (
            <span className="qf-badge qf-badge--count" data-testid="pin-panel-count">
              {items.length}
            </span>
          ) : null}
        </h2>
        <div className="ml-auto">
          <button
            type="button"
            data-testid="pin-panel-close"
            aria-label="핀 패널 닫기"
            onClick={onClose}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-[var(--s-3)]">
        {query.isLoading ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-[var(--s-2)]">
            {/* S50 review (a11y A-PP-07): role="status" 컨테이너에 SR 전용 텍스트를
                넣어 로딩 상태가 안정적으로 읽히게 한다(aria-busy 단독은 불충분). */}
            <span className="sr-only">고정된 메시지 목록 불러오는 중</span>
            <div className="qf-skel h-[var(--s-9)] w-full" aria-hidden="true" />
            <div className="qf-skel h-[var(--s-9)] w-full" aria-hidden="true" />
            <div className="qf-skel h-[var(--s-9)] w-full" aria-hidden="true" />
          </div>
        ) : items.length === 0 ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="pin-panel-empty"
            className="px-[var(--s-2)] py-[var(--s-4)] text-[length:var(--fs-13)] text-text-secondary"
          >
            아직 고정된 메시지가 없습니다.
          </p>
        ) : (
          <ul className="flex flex-col gap-[var(--s-2)]">
            {items.map((m) => (
              <PinRow
                key={m.id}
                msg={m}
                authorName={nameByUserId.get(m.authorId) ?? '알 수 없음'}
                onJump={() => onJump(m.id)}
                onUnpin={() => unpin.mutate(m.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function PinRow({
  msg,
  authorName,
  onJump,
  onUnpin,
}: {
  msg: MessageDto;
  authorName: string;
  onJump: () => void;
  onUnpin: () => void;
}): JSX.Element {
  // S50 review (a11y A-PP-04/05): 점프·해제 버튼은 패널에 여러 개 나열되므로
  // aria-label 에 작성자 + 본문 발췌를 담아 항목별로 구분되게 한다(동일 레이블
  // 반복 방지). 발췌는 plain 미리보기(없으면 content) 30자.
  const excerpt = msg.deleted ? '삭제된 메시지' : (msg.contentPlain ?? '').slice(0, 30) || '메시지';
  return (
    <li
      data-testid={`pin-row-${msg.id}`}
      className="group rounded-md border border-border bg-chat p-[var(--s-2)]"
    >
      <div className="flex items-baseline gap-[var(--s-2)]">
        <span className="text-[length:var(--fs-13)] font-semibold text-foreground">
          {authorName}
        </span>
        <time className="qf-message__time" dateTime={msg.pinnedAt ?? msg.createdAt}>
          <span className="sr-only">고정 시각: </span>
          {new Date(msg.pinnedAt ?? msg.createdAt).toLocaleString()}
        </time>
      </div>
      <button
        type="button"
        data-testid={`pin-jump-${msg.id}`}
        onClick={onJump}
        aria-label={`${authorName}의 "${excerpt}" 원본 메시지로 이동`}
        className={cn(
          'mt-[var(--s-1)] block w-full text-left text-[length:var(--fs-13)] text-text-secondary',
          // FR-PS-03: 2줄 클램프.
          'line-clamp-2 cursor-pointer hover:text-foreground',
        )}
      >
        {msg.deleted ? (
          <span className="italic text-text-muted">[삭제된 메시지]</span>
        ) : (
          renderMessageContent(msg.content ?? '')
        )}
      </button>
      <div className="mt-[var(--s-1)] flex justify-end">
        <button
          type="button"
          data-testid={`pin-unpin-${msg.id}`}
          onClick={onUnpin}
          aria-label={`${authorName}의 메시지 고정 해제`}
          className="qf-btn qf-btn--ghost qf-btn--sm text-[length:var(--fs-12)] text-text-secondary"
        >
          고정 해제
        </button>
      </div>
    </li>
  );
}
