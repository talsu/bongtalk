import type { SaveStatus, SavedMessageDto } from '@qufox/shared-types';
import {
  DropdownContent,
  DropdownItem,
  DropdownRoot,
  DropdownSeparator,
  DropdownTrigger,
  Icon,
} from '../../design-system/primitives';
import { formatMessageTime } from '../messages/formatMessageTime';

// S51 (D10 / FR-PS-07) + S52 (FR-PS-08): 저장함 단일 항목. 원본 요약(excerpt) + 채널
// 컨텍스트 + 저장 시각 + 탭별 액션(완료 인라인 체크 + "⋯" 드롭다운: 보관/진행중 복원/
// 완료/저장해제). 삭제된 원본은 excerpt 가 '[삭제된 메시지]' 로 마스킹돼 내려오며,
// 액션 UI 는 삭제 항목에도 그대로 렌더된다(FR-PS-12 잔존 항목 액션 보장).
export function SavedItem({
  item,
  onUnsave,
  onMove,
  onOpenReminder,
}: {
  item: SavedMessageDto;
  // 저장 해제(영구 — item.messageId 로 DELETE /me/saved/:messageId 재사용).
  onUnsave: (messageId: string) => void;
  // 탭(status) 이동(item.id 로 PATCH /me/saved/:savedMessageId). from 은 현재 탭.
  onMove: (savedMessageId: string, from: SaveStatus, to: SaveStatus) => void;
  // S53 (FR-PS-09): 리마인더 설정 모달 열기(항목 컨텍스트 전달).
  onOpenReminder?: (item: SavedMessageDto) => void;
}): JSX.Element {
  const deleted = item.messageDeletedAt !== null;
  const from = item.status;
  // S53: 예약된(미발화) 리마인더가 있으면 bell 배지로 시각을 표시한다. 리뷰(reviewer m1):
  // 발화 후(reminderFiredAt 기록)에는 reminderAt 가 남아도 더 이상 대기 중이 아니므로
  // 배지를 숨긴다(과거 시각 stale 배지 방지).
  const reminderAt = item.reminderAt ?? null;
  const hasReminder = reminderAt !== null && (item.reminderFiredAt ?? null) === null;
  // 탭별 가용 이동 액션(저장해제는 항상 가능). 자기 자신 탭으로의 이동은 제외한다.
  // IN_PROGRESS: 보관·완료 / ARCHIVED: 진행중 복원·완료 / COMPLETED: 진행중 복원.
  const canArchive = from === 'IN_PROGRESS';
  const canComplete = from === 'IN_PROGRESS' || from === 'ARCHIVED';
  const canRestore = from === 'ARCHIVED' || from === 'COMPLETED';
  // S52 리뷰(a11y B-01/B-02): 목록에 항목이 여러 개라 동일 접근명("완료로 표시"/
  // "저장 항목 작업")이 반복되면 SR 이 구분 못 한다. 채널명+발췌로 항목별 컨텍스트를 실는다.
  const ctx = `#${item.channelName} ${(item.excerpt ?? '').slice(0, 30)}`.trim();

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
          {hasReminder ? (
            <span
              data-testid={`saved-reminder-badge-${item.messageId}`}
              role="img"
              aria-label={`리마인더: ${formatMessageTime(reminderAt, new Date())}`}
              className="inline-flex items-center gap-[var(--s-1)] text-text-secondary"
              style={{ font: '500 var(--fs-12) var(--font-sans)' }}
            >
              <Icon name="bell" size="sm" aria-hidden />
              {formatMessageTime(reminderAt, new Date())}
            </span>
          ) : null}
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

      <div className="flex items-center gap-[var(--s-1)]">
        {/* 인라인 1-click 완료 체크(IN_PROGRESS/ARCHIVED 에서만). */}
        {canComplete ? (
          <button
            type="button"
            data-testid={`saved-complete-${item.messageId}`}
            onClick={() => onMove(item.id, from, 'COMPLETED')}
            aria-label={`완료로 표시 — ${ctx}`}
            title="완료로 표시"
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            <Icon name="check" size="sm" />
          </button>
        ) : null}

        {/* "⋯" 드롭다운 — 탭별 가용 액션. */}
        <DropdownRoot>
          <DropdownTrigger asChild>
            <button
              type="button"
              data-testid={`saved-more-${item.messageId}`}
              aria-label={`저장 항목 작업 — ${ctx}`}
              className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
            >
              <Icon name="more" size="sm" />
            </button>
          </DropdownTrigger>
          <DropdownContent align="end">
            {canRestore ? (
              <DropdownItem onSelect={() => onMove(item.id, from, 'IN_PROGRESS')}>
                <span
                  className="inline-flex items-center gap-[var(--s-2)]"
                  data-testid={`saved-action-restore-${item.messageId}`}
                >
                  <Icon name="clock" size="sm" /> 진행 중으로 복원
                </span>
              </DropdownItem>
            ) : null}
            {canArchive ? (
              <DropdownItem onSelect={() => onMove(item.id, from, 'ARCHIVED')}>
                <span
                  className="inline-flex items-center gap-[var(--s-2)]"
                  data-testid={`saved-action-archive-${item.messageId}`}
                >
                  <Icon name="inbox" size="sm" /> 보관
                </span>
              </DropdownItem>
            ) : null}
            {canComplete ? (
              <DropdownItem onSelect={() => onMove(item.id, from, 'COMPLETED')}>
                <span
                  className="inline-flex items-center gap-[var(--s-2)]"
                  data-testid={`saved-action-complete-${item.messageId}`}
                >
                  <Icon name="check" size="sm" /> 완료
                </span>
              </DropdownItem>
            ) : null}
            {onOpenReminder ? (
              <DropdownItem onSelect={() => onOpenReminder(item)}>
                <span
                  className="inline-flex items-center gap-[var(--s-2)]"
                  data-testid={`saved-action-reminder-${item.messageId}`}
                >
                  <Icon name="bell" size="sm" /> {hasReminder ? '리마인더 변경' : '리마인더 설정'}
                </span>
              </DropdownItem>
            ) : null}
            <DropdownSeparator />
            <DropdownItem danger onSelect={() => onUnsave(item.messageId)}>
              <span
                className="inline-flex items-center gap-[var(--s-2)]"
                data-testid={`saved-action-unsave-${item.messageId}`}
              >
                <Icon name="bookmark" size="sm" /> 저장 해제
              </span>
            </DropdownItem>
          </DropdownContent>
        </DropdownRoot>
      </div>
    </li>
  );
}
