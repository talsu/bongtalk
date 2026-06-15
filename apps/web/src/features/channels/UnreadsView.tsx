import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Channel } from '@qufox/shared-types';
import { useChannelList } from './useChannels';
import {
  useUnreadSummary,
  useUnreadsPreview,
  useMarkChannelRead,
  useMarkAllRead,
  useUndoMarkAllRead,
} from './useUnread';
import { paginateUnreads, sortUnreadsView } from './unreadsView';
import { markReadAriaLabel } from './unreadsA11y';
import { useNotifications } from '../../stores/notification-store';

const PAGE_SIZE = 20;

type Props = {
  workspaceId: string;
  workspaceSlug: string;
};

/**
 * S24 (FR-RS-10): Unreads View — 사이드바 최상단 상시 노출 뷰.
 *
 *  - mentionCount 있는 채널 우선 → 최신 활동순 정렬(unreadsView 순수 로직 재사용).
 *  - 각 채널 블록에 "읽음 처리" 버튼(채널 최신까지 ACK 전진 = markRead 재사용).
 *  - 하단 "모두 읽음" → read-all 호출 → 5초 Undo 토스트("실행 취소" → undo).
 *  - 읽지 않음 없으면 empty state("모든 채널을 읽으셨습니다").
 *  - 커서 페이지네이션("더 보기")은 클라 캐시 기반(paginateUnreads).
 *  - DS 기존 클래스만(qf-channel / qf-badge / qf-btn / qf-category) — 신규 0.
 */
export function UnreadsView({ workspaceId, workspaceSlug }: Props): JSX.Element | null {
  const { data: unread } = useUnreadSummary(workspaceId);
  // 072 백로그 S-I (FR-RS-10 / N6-1): 채널별 최근 읽지 않은 메시지 미리보기(작성자+본문). 배지는
  // useUnreadSummary(라이브 patch), 미리보기 본문은 이 엔드포인트(30s/포커스 + message.created 무효화).
  const { data: previewData } = useUnreadsPreview(workspaceId);
  const { data: channelData } = useChannelList(workspaceId);
  const markReadMut = useMarkChannelRead(workspaceId);
  const markAllMut = useMarkAllRead(workspaceId);
  const undoMut = useUndoMarkAllRead(workspaceId);
  const notify = useNotifications((s) => s.push);
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(0);

  // channelId → name (네비게이션 + 표시). uncategorized + 카테고리 채널 전부.
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    const all: Channel[] = [
      ...(channelData?.uncategorized ?? []),
      ...((channelData?.categories ?? []).flatMap((c) => c.channels) ?? []),
    ];
    for (const c of all) m.set(c.id, c.name);
    return m;
  }, [channelData]);

  // 072 백로그 S-B (FR-CH-04): 보관 채널은 '읽지 않음' 뷰에서도 제외(사이드바 숨김과 정합,
  // 유령 읽지 않음 행 방지). archivedAt 집합을 채널 데이터에서 만든다.
  const archivedSet = useMemo(() => {
    const s = new Set<string>();
    for (const c of [
      ...(channelData?.uncategorized ?? []),
      ...((channelData?.categories ?? []).flatMap((c) => c.channels) ?? []),
    ]) {
      if (c.archivedAt) s.add(c.id);
    }
    return s;
  }, [channelData]);

  const sorted = useMemo(
    () => sortUnreadsView((unread?.channels ?? []).filter((r) => !archivedSet.has(r.channelId))),
    [unread, archivedSet],
  );
  const page = useMemo(() => paginateUnreads(sorted, cursor, PAGE_SIZE), [sorted, cursor]);

  // 072 백로그 S-I: channelId → 최근 읽지 않은 메시지 1건(미리보기 라인). messages 는 newest-first 라 [0].
  const previewByChannel = useMemo(() => {
    const m = new Map<
      string,
      { authorUsername: string | null; preview: string | null; masked: boolean }
    >();
    for (const c of previewData?.items ?? []) {
      const top = c.messages[0];
      if (top)
        m.set(c.channelId, {
          authorUsername: top.authorUsername,
          preview: top.preview,
          masked: top.masked,
        });
    }
    return m;
  }, [previewData]);

  function previewLine(channelId: string): string | null {
    const p = previewByChannel.get(channelId);
    if (!p) return null;
    // 072 S-I 리뷰(LOW): 차단 마스킹 문구를 메시지 도메인 정본(BLOCKED_MESSAGE_PLACEHOLDER
    // = '[차단된 사용자의 메시지]')과 동일하게 맞춘다.
    if (p.masked) return '[차단된 사용자의 메시지]';
    const who = p.authorUsername ? `${p.authorUsername}: ` : '';
    const body = p.preview ?? '(내용 없음)';
    return `${who}${body}`;
  }

  const onMarkAll = (): void => {
    markAllMut.mutate(undefined, {
      onSuccess: (res) => {
        if (!res || res.channelsRead === 0) return;
        // FR-RS-18: Undo 토스트. a11y MOD #8(WCAG 2.2.1): SR/키보드 사용자를 위해
        // TTL 을 8초로 잡고(종전 5초), Toast 가 hover/focus 시 타이머를 일시정지한다.
        notify({
          variant: 'info',
          title: '모든 채널을 읽음 처리했어요',
          body: `${res.channelsRead}개 채널`,
          ttlMs: 8000,
          action: {
            label: '실행 취소',
            onClick: () => undoMut.mutate(res.snapshotId),
          },
        });
      },
    });
  };

  if (sorted.length === 0) {
    return (
      <section data-testid="unreads-view" aria-label="읽지 않은 채널" className="mb-[var(--s-3)]">
        <div className="qf-category">읽지 않음</div>
        {/* ui-designer MED #7: empty state 를 DS qf-empty/qf-empty__body 로. 사이드바
            폭에 맞춰 page-scoped 패딩 토큰만 오버라이드(raw px 금지, var() 토큰만). */}
        <div data-testid="unreads-empty" className="qf-empty px-[var(--s-3)] py-[var(--s-5)]">
          <p className="qf-empty__body">모든 채널을 읽으셨습니다</p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="unreads-view" aria-label="읽지 않은 채널" className="mb-[var(--s-3)]">
      <div className="qf-category">읽지 않음</div>
      <ul>
        {page.rows.map((row) => {
          const name = nameById.get(row.channelId) ?? row.channelId.slice(0, 6);
          // 072 백로그 S-I: 최근 읽지 않은 메시지 미리보기 라인(있으면 채널명 아래 1줄).
          const pl = previewLine(row.channelId);
          return (
            <li
              key={row.channelId}
              data-testid={`unread-row-${name}`}
              data-mention={row.hasMention ? 'true' : 'false'}
              // 미리보기 라인이 있으면 2줄 → spacious 높이로 클리핑 방지(S-D 행 패턴).
              className={
                pl
                  ? 'qf-channel qf-channel--unread group relative !h-auto flex-col items-stretch py-[var(--s-1)]'
                  : 'qf-channel qf-channel--unread group relative'
              }
            >
              <div className="flex w-full items-center">
                <button
                  type="button"
                  onClick={() => navigate(`/w/${workspaceSlug}/${name}`)}
                  // 072 S-I 리뷰(LOW): 미리보기를 접근명에 합쳐 SR 가 행과 연결해 읽게 한다
                  // (아래 미리보기 div 는 aria-hidden 으로 중복 낭독 방지).
                  aria-label={pl ? `# ${name} 채널 열기, 최근: ${pl}` : `# ${name} 채널 열기`}
                  className="flex min-w-0 flex-1 items-center bg-transparent text-left"
                >
                  <span className="qf-channel__prefix">#</span>
                  <span className="flex-1 truncate">&nbsp;{name}</span>
                </button>
                <span className="qf-channel__suffix">
                  {row.mentionCount > 0 ? (
                    <span
                      data-testid={`unread-row-mention-${name}`}
                      aria-label={`읽지 않은 멘션 ${row.mentionCount}개`}
                      className="qf-badge qf-badge--count"
                    >
                      {row.mentionCount > 99 ? '99+' : row.mentionCount}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    data-testid={`unread-row-markread-${name}`}
                    // a11y BLOCKER #5: 채널별 고유 라벨(다중 동일 "읽음 처리" 라벨 해소).
                    aria-label={markReadAriaLabel(name)}
                    onClick={() => markReadMut.mutate(row.channelId)}
                    className="qf-btn qf-btn--ghost qf-btn--sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    읽음 처리
                  </button>
                </span>
              </div>
              {/* 072 백로그 S-I: 최근 읽지 않은 메시지 미리보기(작성자: 내용 / 차단 마스킹). */}
              {pl ? (
                <div
                  data-testid={`unread-preview-${name}`}
                  aria-hidden
                  className="truncate pl-[var(--s-5)] text-[length:var(--fs-12)] text-text-muted"
                >
                  {pl}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between px-[var(--s-2)] py-[var(--s-2)]">
        {page.nextCursor !== null ? (
          <button
            type="button"
            data-testid="unreads-load-more"
            // a11y BLOCKER #5: 모호한 "더 보기" 대신 의미를 명시.
            aria-label="읽지 않은 채널 더 보기"
            onClick={() => setCursor(page.nextCursor ?? 0)}
            className="qf-btn qf-btn--ghost qf-btn--sm"
          >
            더 보기
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          data-testid="unreads-mark-all"
          onClick={onMarkAll}
          disabled={markAllMut.isPending}
          // a11y BLOCKER #5: pending 동안 SR 에 진행 상태 안내.
          aria-busy={markAllMut.isPending}
          className="qf-btn qf-btn--ghost qf-btn--sm"
        >
          모두 읽음
        </button>
      </div>
    </section>
  );
}
