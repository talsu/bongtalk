import type { MessageDto } from '@qufox/shared-types';
import { usePins, useUnpinMessage } from '../../features/messages/useMessages';
import { renderMessageContent } from '../../features/messages/parseContent';
import { Icon } from '../../design-system/primitives';

/**
 * 071-M3 F3 (FR-PS-04 모바일 / 감사 A-8) — 채널 핀 목록(모바일).
 *
 * 데스크톱 PinPanel 은 qf-thread-panel 고정폭 aside 골격이라 컴포넌트 재사용
 * 대신 훅(usePins/useUnpinMessage)과 행 렌더 패턴만 이식한다. 항목 탭 → 호출측
 * 이 현재 채널 URL 에 `?msg=<id>` 를 세팅하면 MobileMessages 의 기존 점프
 * 소비(스크롤+2초 강조)가 처리한다. 해제는 canUnpin(권한 게이트) 시에만 노출.
 */
export function MobilePinList({
  workspaceId,
  channelId,
  nameByUserId,
  canUnpin,
  onJump,
}: {
  workspaceId: string;
  channelId: string;
  nameByUserId: Map<string, string>;
  canUnpin: boolean;
  onJump: (messageId: string) => void;
}): JSX.Element {
  const { data, isLoading } = usePins(workspaceId, channelId, true);
  const unpinMut = useUnpinMessage(workspaceId, channelId);
  const items = data?.items ?? [];

  if (isLoading) {
    return (
      <div className="qf-m-empty">
        <div className="qf-m-empty__body">불러오는 중…</div>
      </div>
    );
  }
  // SettingsOverlay 의 닫기 버튼이 absolute 우상단이라, 섹션 헤더로 첫 행을
  // 그 아래로 내린다(겹침 시 해제 X 와 닫기 X 가 동일 좌표 — F3 프로브 실측).
  const header = (
    <div className="qf-m-section">
      <div>고정된 메시지{items.length > 0 ? ` · ${items.length}` : ''}</div>
    </div>
  );
  if (items.length === 0) {
    return (
      <div>
        {header}
        <div className="qf-m-empty" data-testid="mobile-pins-empty">
          <div className="qf-m-empty__title">고정된 메시지가 없습니다</div>
          <div className="qf-m-empty__body">메시지를 길게 눌러 '메시지 고정'을 선택해 보세요.</div>
        </div>
      </div>
    );
  }
  return (
    <div>
      {header}
      <ul aria-label="고정된 메시지" data-testid="mobile-pin-list">
        {items.map((m: MessageDto) => (
          <li key={m.id} className="flex items-stretch">
            <button
              type="button"
              data-testid={`mobile-pin-jump-${m.id}`}
              className="qf-m-row min-w-0 flex-1 text-left"
              onClick={() => onJump(m.id)}
            >
              <Icon name="pin" size="sm" className="text-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="qf-m-row__primary block truncate">
                  {nameByUserId.get(m.authorId) ?? 'unknown'}
                </span>
                <span className="qf-m-row__secondary line-clamp-2 block">
                  {renderMessageContent(m.content ?? '')}
                </span>
              </span>
            </button>
            {canUnpin ? (
              <button
                type="button"
                data-testid={`mobile-pin-unpin-${m.id}`}
                aria-label="고정 해제"
                style={{ minWidth: 'var(--m-touch)', minHeight: 'var(--m-touch)' }}
                className="grid place-items-center text-text-muted"
                onClick={() => unpinMut.mutate(m.id)}
              >
                <Icon name="x" size="sm" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
