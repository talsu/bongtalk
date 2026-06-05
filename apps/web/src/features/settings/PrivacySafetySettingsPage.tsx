import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PRIVACY, type FriendReqPolicy, FriendReqPolicySchema } from '@qufox/shared-types';
import { Avatar } from '../../design-system/primitives';
import { Dialog } from '../../design-system/primitives/Dialog';
import { useNotifications } from '../../stores/notification-store';
import { useFriendsList, useUnblockUser } from '../friends/useFriends';
import { usePrivacySettings, useUpdatePrivacySettings } from './usePrivacySettings';

const FRIEND_REQ_OPTIONS: ReadonlyArray<{ value: FriendReqPolicy; label: string }> = [
  { value: 'EVERYONE', label: '누구나' },
  { value: 'MUTUAL_WORKSPACE', label: '같은 워크스페이스 멤버만' },
  { value: 'NOBODY', label: '받지 않음' },
];

/**
 * S75 (D14 / FR-PS-14): 개인정보/안전 설정 — 차단 목록 + 해제.
 *
 * 차단 목록은 기존 FriendsController(GET /me/friends?status=blocked)를 100% 재사용한다
 * (신규 차단 API 없음). 해제는 DELETE /me/friends/block/:userId(useUnblockUser).
 *
 * S75 fix-forward (F13): 해제 성공 시 useUnblockUser 가 `['friends']` + `['messages']`
 * 캐시를 함께 무효화한다 — 이 탭에서 열린 채널/DM 메시지의 `[차단된 사용자의
 * 메시지]` 마스킹이 풀린 원문으로 즉시 재로드된다. 다른 탭/기기로의 실시간 전파
 * (`user:unblocked` WS → useUserUnblocked)는 현재 어떤 Shell 에도 배선돼 있지 않다
 * (dormant — useUserUnblocked.ts 의 carryover 참고). 따라서 본 페이지는 mutation
 * onSuccess 의 직접 무효화에만 의존한다.
 *
 * NotificationSettingsPage 와 동일한 설정 페이지 셸(qf-* + DS 토큰)을 쓴다.
 */
export function PrivacySafetySettingsPage(): JSX.Element {
  const { data, isLoading } = useFriendsList('blocked');
  const unblock = useUnblockUser();
  const notify = useNotifications((s) => s.push);
  const blocked = data?.items ?? [];

  // S77a (FR-PS-13): 프라이버시 설정(자동 저장). 기존 차단 목록 섹션은 그대로 유지한다.
  const { data: privacyData } = usePrivacySettings();
  const updatePrivacy = useUpdatePrivacySettings();
  const privacy = privacyData ?? DEFAULT_PRIVACY;

  // 자동저장 성공 시 SR 통지(S76 F-H4 선례).
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );
  const savePrivacy = (
    patch: Parameters<typeof updatePrivacy.mutateAsync>[0],
    failTitle: string,
  ): void => {
    void updatePrivacy
      .mutateAsync(patch)
      .then(() => {
        setSavedAt(Date.now());
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSavedAt(null), 3000);
      })
      .catch((err: unknown) => {
        notify({
          variant: 'danger',
          title: failTitle,
          body: err instanceof Error ? err.message : '잠시 후 다시 시도해 주세요.',
        });
      });
  };
  const onFriendReqPolicy = (raw: string): void => {
    const parsed = FriendReqPolicySchema.safeParse(raw);
    if (!parsed.success) return;
    savePrivacy({ allowFriendRequests: parsed.data }, '친구 요청 정책 저장 실패');
  };

  // F11 (a11y M-5): 차단 해제 즉시실행은 오클릭 위험 → 확인 단계(alertDialog)를 둔다.
  const [confirmTarget, setConfirmTarget] = useState<{
    userId: string;
    username: string;
  } | null>(null);

  const runUnblock = (userId: string, username: string): void => {
    unblock.mutate(
      { userId },
      {
        onSuccess: () =>
          notify({ variant: 'success', title: '차단 해제됨', body: `@${username}`, ttlMs: 2500 }),
        onError: () =>
          notify({
            variant: 'danger',
            title: '차단 해제 실패',
            body: '잠시 후 다시 시도하세요.',
            ttlMs: 4000,
          }),
      },
    );
  };

  return (
    // F-M3 / F-B3: bare 콘텐츠 — 프레임(main/bg/패딩)은 SettingsShell 의 qf-settings__main 이
    // 제공한다. 자체 <main>/bg/외곽패딩/"닫기" 링크를 제거(중첩·이중 배경/패딩/스크롤 해소).
    <div data-testid="privacy-safety-settings">
      <div className="mx-auto max-w-[var(--w-settings)]">
        <div className="mb-[var(--s-5)]">
          <div className="qf-eyebrow">settings</div>
          <h1 className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
            개인정보 및 안전
          </h1>
        </div>

        {/* S77a (FR-PS-13): 프라이버시 — DM/메시지요청/친구요청 정책(자동 저장). */}
        <section
          className="mb-[var(--s-6)] rounded-[var(--r-xl)] border border-border bg-bg-surface p-[var(--s-5)]"
          aria-labelledby="privacy-prefs-heading"
          data-testid="privacy-prefs"
        >
          <h2
            id="privacy-prefs-heading"
            className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
          >
            메시지 및 친구 요청
          </h2>
          <p className="mb-[var(--s-2)] text-[length:var(--fs-12)] text-text-muted">
            누가 나에게 연락할 수 있는지 정합니다. 변경하면 즉시 저장됩니다.
          </p>

          {/* 워크스페이스 멤버발 DM 허용 — 서버 게이트(createOrGet)가 실제로 차단/허용한다. */}
          <div className="qf-toggle-row">
            <div className="qf-toggle-row__text">
              <div className="qf-toggle-row__title">같은 워크스페이스 멤버의 DM 받기</div>
              <div className="qf-toggle-row__desc">
                끄면 같은 워크스페이스에 속해 있다는 이유만으로는 새 DM 을 받지 않습니다(친구는 계속
                보낼 수 있습니다).
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={privacy.allowDmFromWorkspaceMembers}
              aria-label="같은 워크스페이스 멤버의 DM 받기"
              disabled={updatePrivacy.isPending}
              data-testid="privacy-allow-dm-toggle"
              className="qf-switch"
              onClick={() =>
                savePrivacy(
                  { allowDmFromWorkspaceMembers: !privacy.allowDmFromWorkspaceMembers },
                  'DM 설정 저장 실패',
                )
              }
            />
          </div>

          {/* 메시지 요청 수신 — message-request 인프라 부재로 현재는 설정 저장만(정직한 라벨). */}
          <div className="qf-toggle-row">
            <div className="qf-toggle-row__text">
              <div className="qf-toggle-row__title">메시지 요청 수신 허용</div>
              <div className="qf-toggle-row__desc">
                친구가 아닌 사용자의 메시지 요청을 받을지 정합니다. (메시지 요청 기능은 준비 중이며,
                이 설정은 미리 저장됩니다.)
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={privacy.messageRequestEnabled}
              aria-label="메시지 요청 수신 허용"
              disabled={updatePrivacy.isPending}
              data-testid="privacy-message-request-toggle"
              className="qf-switch"
              onClick={() =>
                savePrivacy(
                  { messageRequestEnabled: !privacy.messageRequestEnabled },
                  '메시지 요청 설정 저장 실패',
                )
              }
            />
          </div>

          {/* 친구 요청 정책 — 서버 게이트(requestByUsername)가 실제로 강제한다. */}
          <div className="qf-field pt-[var(--s-5)]">
            <label className="qf-field__label" htmlFor="privacy-friend-req">
              친구 요청 받기
            </label>
            <select
              id="privacy-friend-req"
              data-testid="privacy-friend-req-select"
              className="qf-input"
              value={privacy.allowFriendRequests}
              disabled={updatePrivacy.isPending}
              onChange={(e) => onFriendReqPolicy(e.target.value)}
            >
              {FRIEND_REQ_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* 자동저장 상태 라이브 영역(S76 F-H4 선례 — sr-only). */}
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="privacy-save-status"
            className="sr-only"
          >
            {savedAt !== null ? '저장됨' : ''}
          </p>
        </section>

        <section
          className="mb-[var(--s-6)] rounded-[var(--r-xl)] border border-border bg-bg-surface p-[var(--s-5)]"
          aria-labelledby="blocked-users-heading"
        >
          <h2
            id="blocked-users-heading"
            className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
          >
            차단한 사용자
          </h2>
          <p className="mb-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted">
            차단한 사용자의 메시지는 가려지고, DM/멘션을 받을 수 없습니다. 해제하면 다시 표시됩니다.
          </p>

          {isLoading ? (
            <div role="status" aria-busy="true" className="flex flex-col gap-[var(--s-2)]">
              <span className="sr-only">차단 목록 불러오는 중</span>
              <div className="qf-skel h-[var(--s-9)] w-full" aria-hidden="true" />
              <div className="qf-skel h-[var(--s-9)] w-full" aria-hidden="true" />
            </div>
          ) : blocked.length === 0 ? (
            <p
              role="status"
              data-testid="blocked-empty"
              className="py-[var(--s-4)] text-[length:var(--fs-13)] text-text-secondary"
            >
              차단한 사용자가 없습니다.
            </p>
          ) : (
            <ul className="flex flex-col gap-[var(--s-2)]">
              {blocked.map((row) => (
                <li
                  key={row.friendshipId}
                  data-testid={`blocked-row-${row.otherUserId}`}
                  className="flex items-center gap-[var(--s-3)] rounded-md border border-border-subtle p-[var(--s-3)]"
                >
                  <Avatar name={row.otherUsername} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--fs-14)] text-foreground">
                    @{row.otherUsername}
                  </span>
                  <button
                    type="button"
                    data-testid={`blocked-unblock-${row.otherUserId}`}
                    // F6 (a11y H-1): 모든 해제 버튼이 같은 텍스트 "차단 해제"라
                    // 접근명이 중복된다 — 대상 @username 을 aria-label 에 포함한다.
                    aria-label={`@${row.otherUsername} 차단 해제`}
                    onClick={() =>
                      setConfirmTarget({ userId: row.otherUserId, username: row.otherUsername })
                    }
                    // F10 (a11y M-3): 해제 진행 중 표시. 해당 대상이 처리 중일 때만 busy.
                    aria-busy={unblock.isPending && confirmTarget?.userId === row.otherUserId}
                    disabled={unblock.isPending}
                    className="qf-btn qf-btn--secondary qf-btn--sm"
                  >
                    차단 해제
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* F11 (a11y M-5): 차단 해제 확인 다이얼로그(alertDialog — 의사 결정 환기). */}
      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmTarget(null);
        }}
        alertDialog
        title="차단을 해제할까요?"
        description={
          confirmTarget
            ? `@${confirmTarget.username} 의 메시지와 DM/멘션이 다시 표시됩니다.`
            : undefined
        }
      >
        <div className="flex justify-end gap-[var(--s-2)]">
          <button
            type="button"
            data-testid="unblock-confirm-cancel"
            onClick={() => setConfirmTarget(null)}
            className="qf-btn qf-btn--ghost qf-btn--sm"
          >
            취소
          </button>
          <button
            type="button"
            data-testid="unblock-confirm-ok"
            onClick={() => {
              if (confirmTarget) runUnblock(confirmTarget.userId, confirmTarget.username);
              setConfirmTarget(null);
            }}
            className="qf-btn qf-btn--secondary qf-btn--sm"
          >
            차단 해제
          </button>
        </div>
      </Dialog>
    </div>
  );
}
