import { useEffect, useRef } from 'react';
import { Dialog } from '../../design-system/primitives/Dialog';
import { Avatar } from '../../design-system/primitives/Avatar';
import { Scrollable } from '../../design-system/primitives/Scrollable';
import { useReactionUsers } from './useReactionUsers';

type Props = {
  messageId: string | null;
  emoji: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * S40 (FR-RE05): 반응 칩을 누르면 열리는 **전체 reactor 목록** 모달. FR-RE04 의
 * 아바타 스택(≤5명)을 넘어 한 이모지에 반응한 전원을 cursor 페이지네이션으로
 * 무한 스크롤한다.
 *
 * a11y: DS `Dialog`(Radix Dialog 기반) primitive 를 재사용한다 — role="dialog" +
 * aria-modal="true" + focus trap + Esc 닫기 + 트리거로의 포커스 복귀가 Radix 에서
 * 모두 보장된다. 신규 DS 클래스는 만들지 않고(qf-* 기존 토큰/유틸만 사용),
 * EmojiPicker 의 선존 a11y 부채(role=menu)와 무관한 정확한 dialog 시맨틱을 신설한다.
 * 목록(role=list 인 <ul>)에 aria-busy 를 붙여 로딩 상태를 SR 에 알리고, 로딩 텍스트는
 * role="status"+aria-live 로 통지하며, 무한 스크롤 센티넬은 시각적으로만 존재한다
 * (aria-hidden).
 */
export function ReactionUsersModal({ messageId, emoji, open, onOpenChange }: Props): JSX.Element {
  const query = useReactionUsers(messageId, emoji, open);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  // 무한 스크롤: 센티넬이 뷰포트(스크롤 컨테이너)에 들어오면 다음 페이지를 당긴다.
  useEffect(() => {
    if (!open) return;
    const el = sentinelRef.current;
    if (!el) return;
    // jsdom/SSR 등 IntersectionObserver 미지원 환경에서는 무한 스크롤을 건너뛴다
    // (모달 자체와 첫 페이지 렌더는 그대로 동작 — 회귀 없음).
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { threshold: 1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const users = query.data?.pages.flatMap((p) => p.users) ?? [];
  const title = emoji ? `${emoji} 반응한 사람` : '반응한 사람';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="이 반응을 누른 사람의 전체 목록입니다."
    >
      <Scrollable className="max-h-[40vh]">
        {/* MOD-2: 목록에 aria-label + role=list 시맨틱. aria-busy 는 plain div 인
            Scrollable 이 아니라 role=list 인 <ul> 에 붙여야 AT 가 인식한다(종전엔
            Scrollable 에 붙어 무시됐다). MOD-3: username null 폴백으로 cuid 노출 방지. */}
        <ul
          className="flex flex-col gap-[var(--s-1)]"
          aria-label={emoji ? `${emoji} 반응한 사람 목록` : '반응한 사람 목록'}
          aria-busy={query.isLoading || isFetchingNextPage}
        >
          {users.map((u) => (
            <li
              key={u.id}
              className="flex items-center gap-[var(--s-3)] py-[var(--s-2)] px-[var(--s-1)]"
            >
              <Avatar name={u.username ?? '(알 수 없는 사용자)'} size="sm" />
              <span className="text-[length:var(--fs-15)] text-foreground">
                {u.username ?? '(알 수 없는 사용자)'}
              </span>
            </li>
          ))}
        </ul>
        {query.isLoading ? (
          <p
            role="status"
            aria-live="polite"
            className="py-[var(--s-3)] text-center text-[length:var(--fs-13)] text-text-secondary"
          >
            불러오는 중…
          </p>
        ) : null}
        {!query.isLoading && users.length === 0 ? (
          <p className="py-[var(--s-3)] text-center text-[length:var(--fs-13)] text-text-secondary">
            아직 반응한 사람이 없습니다.
          </p>
        ) : null}
        {/* 무한 스크롤 센티넬 — 시각적 의미가 없어 SR 에서 숨긴다. */}
        <div ref={sentinelRef} aria-hidden="true" className="h-[var(--s-1)]" />
        {isFetchingNextPage ? (
          <p
            role="status"
            aria-live="polite"
            className="py-[var(--s-2)] text-center text-[length:var(--fs-13)] text-text-secondary"
          >
            더 불러오는 중…
          </p>
        ) : null}
      </Scrollable>
    </Dialog>
  );
}
