import type { SavedMessageDto } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { formatMessageTime } from '../messages/formatMessageTime';

// S51 (D10 / FR-PS-07): 저장함 단일 항목. 원본 요약(excerpt) + 채널 컨텍스트 + 저장
// 시각 + 해제 버튼. 삭제된 원본은 excerpt 가 '[삭제된 메시지]' 로 마스킹돼 내려온다.
export function SavedItem({
  item,
  onUnsave,
}: {
  item: SavedMessageDto;
  onUnsave: (messageId: string) => void;
}): JSX.Element {
  const deleted = item.messageDeletedAt !== null;
  return (
    <li
      data-testid={`saved-item-${item.messageId}`}
      className="flex items-start gap-[var(--s-3)] py-[var(--s-3)] border-b border-border-subtle"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[var(--s-2)] text-text-muted">
          <Icon name="hash" size="sm" />
          <span
            className="truncate text-text-secondary"
            style={{ font: '600 var(--fs-13) var(--font-sans)' }}
          >
            {item.channelName}
          </span>
          <span aria-hidden>·</span>
          <time dateTime={item.savedAt} style={{ font: '400 var(--fs-12) var(--font-sans)' }}>
            {formatMessageTime(item.savedAt, new Date())}
          </time>
        </div>
        <p
          className={deleted ? 'text-text-muted italic' : 'text-foreground'}
          style={{
            font: '400 var(--fs-14)/var(--lh-normal) var(--font-sans)',
            margin: 'var(--s-1) 0 0',
          }}
        >
          {item.excerpt}
        </p>
      </div>
      <button
        type="button"
        data-testid={`saved-unsave-${item.messageId}`}
        onClick={() => onUnsave(item.messageId)}
        aria-label={`저장 해제 — ${item.channelName} · ${(item.excerpt ?? '').slice(0, 30)}`}
        className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
        style={{ color: 'var(--accent)' }}
      >
        <Icon name="bookmark" size="sm" />
      </button>
    </li>
  );
}
