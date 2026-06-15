import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ThreadListItem } from '@qufox/shared-types';
import { useChannelList } from '../channels/useChannels';
import { useMembers } from '../workspaces/useWorkspaces';
import { useNotifications } from '../../stores/notification-store';
import { useMyThreads, useMarkAllThreadsRead } from './useThread';

type Props = {
  workspaceId: string;
  workspaceSlug: string;
};

/**
 * S38 (FR-TH-09 / FR-TH-10): Threads 뷰 — 사이드바 'Threads' 진입점의 펼침 영역.
 *
 *  - 내 구독 스레드 목록(서버: 읽지 않음 우선 → latestReplyAt DESC). cross-workspace
 *    응답을 현재 워크스페이스 채널로 필터해 사이드바 네비게이션과 정합시킨다
 *    (다른 워크스페이스 스레드는 그 워크스페이스 사이드바에서 보인다).
 *  - 각 항목: 채널명 · 루트 excerpt(80자, 서버 cap) · 마지막 답글자 · 상대 시각 ·
 *    읽지 않음 badge. 클릭 시 채널로 이동하며 `?thread=<rootId>` 로 패널을 연다.
 *  - 우상단 '모두 읽음'(FR-TH-10) → markAllThreadsRead → 목록 읽지 않음 0 재수렴.
 *  - DS 기존 클래스만(qf-category / qf-channel / qf-badge / qf-btn / qf-empty) —
 *    신규 DS 0. raw hex/px 없음(var() 토큰 + 등록 Tailwind 유틸만).
 */
export function ThreadsView({ workspaceId, workspaceSlug }: Props): JSX.Element | null {
  const { data, isLoading } = useMyThreads(!!workspaceId);
  const { data: channelData } = useChannelList(workspaceId);
  const { data: members } = useMembers(workspaceId);
  const markAll = useMarkAllThreadsRead();
  const notify = useNotifications((s) => s.push);
  const navigate = useNavigate();

  // 현재 워크스페이스 채널 id→name 맵(네비게이션 + cross-workspace 필터).
  // 채널 목록은 categories[].channels + uncategorized 로 나뉘어 오므로 둘 다 훑는다.
  const channelNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of channelData?.categories ?? []) {
      for (const c of cat.channels) map.set(c.id, c.name);
    }
    for (const c of channelData?.uncategorized ?? []) map.set(c.id, c.name);
    return map;
  }, [channelData]);

  const nameByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members?.members ?? []) map.set(m.userId, m.user.username);
    return map;
  }, [members]);

  // 이 워크스페이스 채널에 속한 스레드만(채널 맵에 있으면 이 워크스페이스 소속).
  const threads: ThreadListItem[] = useMemo(
    () => (data?.threads ?? []).filter((t) => channelNameById.has(t.channelId)),
    [data, channelNameById],
  );

  const openThread = (t: ThreadListItem): void => {
    const channelName = channelNameById.get(t.channelId);
    if (!channelName) return;
    navigate(`/w/${workspaceSlug}/${channelName}?thread=${t.parentMessageId}`);
  };

  const onMarkAll = (): void => {
    markAll.mutate(undefined, {
      onSuccess: (res) => {
        notify({
          variant: 'info',
          title: '스레드를 모두 읽음 처리했어요',
          body: `${res.updated}개 스레드`,
          ttlMs: 6000,
        });
      },
    });
  };

  if (!isLoading && threads.length === 0) {
    return (
      <section data-testid="threads-view" aria-label="스레드" className="mb-[var(--s-3)]">
        <div className="qf-category">스레드</div>
        <div data-testid="threads-empty" className="qf-empty px-[var(--s-3)] py-[var(--s-5)]">
          <p className="qf-empty__body">구독 중인 스레드가 없습니다</p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="threads-view" aria-label="스레드" className="mb-[var(--s-3)]">
      <div className="flex items-center justify-between">
        <div className="qf-category">스레드</div>
        {threads.length > 0 ? (
          <button
            type="button"
            data-testid="threads-mark-all-read"
            onClick={onMarkAll}
            aria-label="구독 중인 모든 스레드를 읽음 처리"
            // S38 fix-forward (a11y B-04): 진행 중 상태를 SR 에 전달 + 중복 클릭
            // 방지(연타로 read-all 이 여러 번 발화하지 않도록 disabled).
            aria-busy={markAll.isPending}
            disabled={markAll.isPending}
            className="qf-btn qf-btn--ghost qf-btn--sm mr-[var(--s-2)]"
          >
            모두 읽음
          </button>
        ) : null}
      </div>
      {/* S38 fix-forward (a11y #9): role="list" 명시(qf-channel 의 display 변경이
          ul 의 암묵 list role 을 제거하는 브라우저 대비). */}
      <ul role="list">
        {threads.map((t) => {
          const channelName = channelNameById.get(t.channelId) ?? t.channelId.slice(0, 6);
          const replier = t.lastReplierId ? nameByUserId.get(t.lastReplierId) : undefined;
          return (
            <li
              key={t.parentMessageId}
              data-testid={`thread-row-${t.parentMessageId}`}
              data-unread={t.unreadCount > 0 ? 'true' : 'false'}
              className="qf-channel group relative"
            >
              <button
                type="button"
                onClick={() => openThread(t)}
                // S38 fix-forward (a11y #9): aria-label 에 읽지 않음 수를 포함해 SR
                // 사용자가 목록을 훑을 때 각 스레드의 읽지 않음 여부를 듣게 한다.
                aria-label={
                  t.unreadCount > 0
                    ? `#${channelName} 스레드 열기, 읽지 않은 답글 ${t.unreadCount}개`
                    : `#${channelName} 스레드 열기`
                }
                className="flex min-w-0 flex-1 flex-col items-start bg-transparent py-[var(--s-1)] text-left"
              >
                <span className="flex w-full min-w-0 items-center gap-[var(--s-2)]">
                  <span className="qf-channel__prefix">#</span>
                  <span className="truncate text-text-strong">{channelName}</span>
                  {/* S38 fix-forward (a11y #9): 상대 시각을 <time dateTime> 로 감싸
                      기계 판독 가능한 ISO 를 노출한다(답글 0개면 dateTime 생략). */}
                  <time
                    dateTime={t.latestReplyAt ?? undefined}
                    className="ml-auto text-[length:var(--fs-11)] text-text-muted"
                  >
                    {formatRelativeTime(t.latestReplyAt)}
                  </time>
                </span>
                <span className="w-full truncate text-[length:var(--fs-12)] text-text-muted">
                  {t.excerpt || '(내용 없음)'}
                </span>
                {replier ? (
                  <span className="text-[length:var(--fs-11)] text-text-muted">
                    마지막 답글 · {replier}
                  </span>
                ) : null}
              </button>
              {t.unreadCount > 0 ? (
                <span className="qf-channel__suffix">
                  <span
                    data-testid={`thread-row-unread-${t.parentMessageId}`}
                    aria-label={`읽지 않은 답글 ${t.unreadCount}개`}
                    className="qf-badge qf-badge--count"
                  >
                    {t.unreadCount > 99 ? '99+' : t.unreadCount}
                  </span>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * 상대 시각 표기. 외부 lib 없이 간단히 분/시간/일/주 단위로 환산한다. null 이면
 * 답글 0개("—"). 클라 시계 기준이라 vi.setSystemTime 고정에도 결정적이다.
 */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return '방금';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  const week = Math.floor(day / 7);
  return `${week}주 전`;
}
