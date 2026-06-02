import { useState } from 'react';
import * as RPopover from '@radix-ui/react-popover';
import type { EditHistoryDto } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { Scrollable } from '../../design-system/primitives';
import { useCustomEmojiLookup } from '../emojis/CustomEmojiContext';
import { useEditHistory } from './useMessages';
import { renderAst, type MentionLookup } from './renderAst';
import { formatMessageTime, formatMessageTimeISO } from './formatMessageTime';

// S37 DS fix-forward: 팝오버 트리거-콘텐츠 간 offset. DS 간격 토큰 --s-2(=4px)
// 와 동치임을 상수+주석으로 명시한다(raw 4 매직넘버 제거). Radix sideOffset 은
// number 만 받으므로 CSS var 를 직접 넘길 수 없어, DS 토큰 값에 맞춘 상수로 둔다.
const POPOVER_OFFSET = 4; // var(--s-2) = 4px

type Props = {
  /** 워크스페이스 id. null(DM)이면 트리거 자체를 노출하지 않습니다. */
  workspaceId: string | null;
  channelId: string;
  msgId: string;
  /**
   * 트리거에 표시할 (수정됨) 라벨 + hover tooltip(최신 편집 시각). 기존
   * MessageItem 의 (수정됨) 뱃지를 그대로 이 팝오버의 trigger 로 감쌉니다.
   */
  editedAt: string | null;
  /**
   * AST 의 mention pill 표시명 해석 룩업(MessageItem 과 동일 prop). 미전달 시
   * userId/channelId 폴백.
   */
  mentions?: MentionLookup;
};

/**
 * S37 (FR-MSG-08): 메시지 편집 이력 팝오버.
 *
 * 트리거: 기존 `(수정됨)` 뱃지를 버튼으로 감싸 클릭 시 팝오버를 엽니다. 팝오버가
 * 열릴 때만 `useEditHistory(enabled)` 로 서버 이력을 가져옵니다(매 메시지 선행
 * fetch 없음).
 *
 * 권한: 서버가 작성자 본인 또는 모더레이터(OWNER/ADMIN, S05 보수 게이트)만 200 을
 * 돌려줍니다. 그 외에는 403(MESSAGE_NOT_AUTHOR) 이며, 이때 팝오버는 "편집 이력을
 * 볼 수 있는 권한이 없습니다" 안내를 표시합니다. 트리거 버튼 자체는 누구에게나
 * 보이지만(다른 사람의 메시지에도 (수정됨) 뱃지는 떠야 함), 본문 노출은 서버가
 * 권위적으로 게이트합니다.
 *
 * DS: 신규 DS 클래스/파일 수정 없이 기존 `.qf-menu` 플로팅 surface 를 재사용하고,
 * 목록 항목은 등록된 DS 토큰(spacing/typography/text-color 등)만 Tailwind
 * arbitrary 로 사용합니다(raw hex/px 금지).
 *
 * a11y: Radix Popover 가 포커스 이동/Esc 닫기/외부 클릭 닫기 + aria-haspopup 을
 * 자동 주입합니다(수동 aria-haspopup 미부여 — N-1). 내용은 비모달이라 role="region"
 * + aria-label(맥락 정보 팝오버 — B-2) 이고 tabIndex={-1} 로 포커스 앵커를 둡니다(B-1).
 */
export function EditHistoryPopover({
  workspaceId,
  channelId,
  msgId,
  editedAt,
  mentions,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const customEmojis = useCustomEmojiLookup();
  const query = useEditHistory(workspaceId, channelId, msgId, open);

  const triggerTitle = editedAt ? new Date(editedAt).toLocaleString() : undefined;

  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Trigger asChild>
        <button
          type="button"
          data-testid={`msg-edited-${msgId}`}
          // DS qf-message__time 토큰 재사용(기존 (수정됨) 뱃지와 동일 톤). 버튼이라
          // 클릭/포커스 가능하지만 UA chrome(테두리/패딩)은 제거해 인라인 라벨과
          // 동일하게 baseline 정렬을 유지합니다(p-0/border-0 은 0 값 — raw px 아님).
          // a11y B-3: 인라인 버튼이라 시인성이 낮으므로 focus-visible 링을 DS
          // --ring-focus 토큰으로 명시한다(키보드 포커스 가시성). N-1: aria-haspopup
          // 은 Radix Trigger 가 자동 주입하므로 수동 부여하지 않는다(중복 방지).
          className="qf-message__time inline cursor-pointer border-0 bg-transparent p-0 underline-offset-2 hover:underline focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
          aria-label="편집 이력 보기"
          title={triggerTitle}
        >
          (수정됨)
        </button>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align="start"
          side="top"
          // DS fix-forward: raw 4 → 상수+주석(POPOVER_OFFSET == var(--s-2) = 4px).
          sideOffset={POPOVER_OFFSET}
          // 기존 DS 플로팅 surface(qf-menu) 재사용 — 신규 DS 클래스 없음. z-overlay
          // 는 기존 DropdownMenu 와 동일(일관 유지). 폭은 DS --w-memberlist(240px)
          // 토큰 기준, 모바일에선 90vw 로 클램프.
          className="qf-menu z-overlay w-[var(--w-memberlist)] max-w-[90vw]"
          // a11y B-1: 비모달 팝오버라 열릴 때 포커스 앵커가 필요하다 — tabIndex={-1}
          // 로 프로그램적 포커스를 허용한다(탭 순서엔 미포함).
          tabIndex={-1}
          // a11y B-2: 비모달 + 맥락 정보 팝오버이므로 role="dialog"(모달 시맨틱)
          // 대신 role="region" 으로 둔다. aria-label 로 영역명을 제공한다.
          role="region"
          aria-label="편집 이력"
          data-testid={`edit-history-popover-${msgId}`}
        >
          <div className="px-[var(--s-2)] pb-[var(--s-2)] pt-[var(--s-1)] text-[length:var(--fs-12)] font-semibold text-text-muted">
            편집 이력
          </div>
          {/* 본문 최대 높이: DS 간격 토큰 calc(--s-12 * 4 = 320px) — raw px 없음. */}
          <Scrollable className="max-h-[calc(var(--s-12)*4)]">
            <EditHistoryBody
              query={query}
              customEmojiByName={customEmojis.byName}
              mentions={mentions}
            />
          </Scrollable>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

/**
 * 팝오버 본문 — react-query 상태(로딩/에러/빈/목록)별 분기. 별도 컴포넌트로
 * 빼 단위 테스트에서 상태별 렌더를 직접 검증할 수 있게 합니다.
 */
function EditHistoryBody({
  query,
  customEmojiByName,
  mentions,
}: {
  query: ReturnType<typeof useEditHistory>;
  customEmojiByName: Parameters<typeof renderAst>[1];
  mentions?: MentionLookup;
}): JSX.Element {
  if (query.isLoading) {
    return (
      <div
        data-testid="edit-history-loading"
        // a11y M-2: 로딩 상태를 SR 에 알리도록 role="status"(live region) 부여.
        role="status"
        className="px-[var(--s-2)] py-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted"
      >
        불러오는 중…
      </div>
    );
  }
  if (query.isError) {
    const code = (query.error as { errorCode?: string } | undefined)?.errorCode;
    const denied = code === 'MESSAGE_NOT_AUTHOR';
    return (
      <div
        role="alert"
        data-testid="edit-history-error"
        className="px-[var(--s-2)] py-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted"
      >
        {denied
          ? '편집 이력을 볼 수 있는 권한이 없습니다.'
          : '편집 이력을 불러오지 못했습니다. 잠시 후 다시 시도하세요.'}
      </div>
    );
  }
  const items = query.data?.items ?? [];
  if (items.length === 0) {
    return (
      <div
        data-testid="edit-history-empty"
        className="px-[var(--s-2)] py-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted"
      >
        편집 이력이 없습니다.
      </div>
    );
  }
  return (
    <ol className="flex flex-col gap-[var(--s-1)]" data-testid="edit-history-list">
      {items.map((item, idx) => (
        <EditHistoryEntry
          // version 은 desc 정렬이며 동일 version 이 중복될 수 없으므로 안정 key.
          key={`${item.version}-${idx}`}
          item={item}
          // 최상단(idx 0)이 가장 최신 편집(직전 본문) — 라벨로 구분.
          isLatest={idx === 0}
          customEmojiByName={customEmojiByName}
          mentions={mentions}
        />
      ))}
    </ol>
  );
}

function EditHistoryEntry({
  item,
  isLatest,
  customEmojiByName,
  mentions,
}: {
  item: EditHistoryDto;
  isLatest: boolean;
  customEmojiByName: Parameters<typeof renderAst>[1];
  mentions?: MentionLookup;
}): JSX.Element {
  return (
    <li
      className={cn(
        'rounded-[var(--r-sm)] px-[var(--s-2)] py-[var(--s-2)]',
        // 항목 구분선: a11y M-1 — 다크모드에서 --divider 는 --bg-elevated 와 동일해
        // 비가시였다. 3:1 대비를 확보하는 --border-strong 토큰으로 교체한다. 마지막
        // 항목 뒤에는 선을 그리지 않는다(DS 토큰 사용 — raw hex 없음).
        'border-b border-[color:var(--border-strong)] last:border-b-0',
      )}
    >
      <div className="mb-[var(--s-1)] flex items-center gap-[var(--s-2)] text-[length:var(--fs-11)] text-text-muted">
        {/* a11y M-3: 상대 시각 라벨은 SR 에 모호하므로 <time> 에 절대 시각을
            aria-label 로 부여한다(SR 은 ISO 절대시각, 시각 사용자는 상대시각). */}
        <time
          dateTime={item.editedAt}
          title={formatMessageTimeISO(item.editedAt)}
          aria-label={formatMessageTimeISO(item.editedAt)}
        >
          {formatMessageTime(item.editedAt, new Date())}
        </time>
        {isLatest ? <span className="qf-badge qf-badge--accent">직전 본문</span> : null}
      </div>
      <div className="qf-message__body text-[length:var(--fs-13)]">
        {/* contentAst 가 있으면 ReDoS-안전 AST 렌더(본문 렌더와 동일 경로), 없으면
            contentPlain 평문 폴백. EditHistoryDto.contentPlain 은 항상 채워집니다. */}
        {item.contentAst
          ? renderAst(item.contentAst, customEmojiByName, mentions)
          : item.contentPlain}
      </div>
    </li>
  );
}
