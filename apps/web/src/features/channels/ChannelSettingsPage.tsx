import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BULK_DELETE_MAX, type Channel } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { Dialog, Button, Input, SettingsOverlay } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useDeleteChannel, useUpdateChannel } from './useChannels';
import { ChannelPrivacyConfirmModal } from './ChannelPrivacyConfirmModal';
import { ChannelPermissionsTab } from './ChannelPermissionsTab';
import { bulkDeleteMessages } from '../messages/api';

// S15 (FR-CH-08): 슬로우모드 간격 프리셋(초). Discord 와 동일한 구간.
const SLOWMODE_OPTIONS: { seconds: number; label: string }[] = [
  { seconds: 0, label: '비활성' },
  { seconds: 5, label: '5초' },
  { seconds: 10, label: '10초' },
  { seconds: 30, label: '30초' },
  { seconds: 60, label: '1분' },
  { seconds: 300, label: '5분' },
  { seconds: 900, label: '15분' },
  { seconds: 3600, label: '1시간' },
  { seconds: 21600, label: '6시간' },
];

// S62 (FR-RM14): 'permissions' 섹션 추가(채널 권한 오버라이드).
// S64 (FR-RM09): 'moderation' 섹션 추가(bulk purge — 최신 N개 일괄 삭제).
type SectionId = 'general' | 'permissions' | 'moderation';

type NavItem =
  | {
      type: 'section';
      id: SectionId;
      label: string;
    }
  | {
      type: 'action';
      id: 'delete';
      label: string;
      danger: true;
    };

/**
 * Channel settings screen based on DS `Patterns > Settings` (see
 * /design-system/index.html § Forms & Settings). Designed so future
 * sections — permissions, integrations, read-state etc. — slot into
 * the NAV_ITEMS array without structural changes.
 *
 * The "채널 삭제" entry is an ACTION, not a section: clicking it fires
 * a confirm dialog and performs the destructive mutation rather than
 * navigating to a separate pane. Matches Discord's right-rail where
 * "Delete channel" lives at the bottom of the nav in red.
 */
export function ChannelSettingsPage({
  workspaceId,
  workspaceSlug,
  channel,
  section,
}: {
  workspaceId: string;
  workspaceSlug: string;
  channel: Channel & { name: string };
  section: SectionId;
}): JSX.Element {
  const navigate = useNavigate();
  const notify = useNotifications((s) => s.push);
  const deleteMut = useDeleteChannel(workspaceId);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const NAV_ITEMS: NavItem[] = [
    { type: 'section', id: 'general', label: '일반' },
    // S62 (FR-RM14): 채널 권한 오버라이드 섹션.
    { type: 'section', id: 'permissions', label: '권한' },
    // S64 (FR-RM09): 메시지 일괄 삭제(bulk purge) 섹션.
    { type: 'section', id: 'moderation', label: '메시지 관리' },
    { type: 'action', id: 'delete', label: '채널 삭제', danger: true },
  ];

  const closeSettings = (): void => {
    navigate(`/w/${workspaceSlug}/${channel.name}`);
  };

  return (
    <SettingsOverlay
      open
      onClose={closeSettings}
      title={`#${channel.name} 설정`}
      testId="channel-settings-overlay"
    >
      <div
        data-testid="channel-settings"
        className="qf-settings flex-1"
        aria-label={`#${channel.name} 설정`}
      >
        <nav className="qf-settings__nav">
          <div className="qf-settings__nav-head"># {channel.name}</div>
          {NAV_ITEMS.map((item) => {
            if (item.type === 'section') {
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`channel-settings-nav-${item.id}`}
                  // S62 fix-forward (a11y B4 · SC 4.1.2): role="tablist" 없이 aria-selected
                  // 를 쓰던 오용을 nav 패턴에 맞는 aria-current="page" 로 대체한다(삭제
                  // 등 action 버튼이 섞인 nav 이므로 tablist 패턴을 쓰지 않는다 — Option B).
                  aria-current={active ? 'page' : undefined}
                  onClick={() =>
                    navigate(`/w/${workspaceSlug}/${channel.name}/settings/${item.id}`)
                  }
                  className="qf-settings__nav-item w-full text-left"
                >
                  {item.label}
                </button>
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`channel-settings-nav-${item.id}`}
                onClick={() => setDeleteOpen(true)}
                // S62 fix-forward (ui-designer M-03): inline color 제거 → text-danger.
                // 색 대비 자체는 DS-owner(라이트 테마 danger 토큰) — 구조만 className 화.
                className="qf-settings__nav-item w-full text-left text-danger"
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <section className="qf-settings__main">
          <header className="mb-[var(--s-5)]">
            {/* S62 fix-forward (ui-designer M-02): inline font shorthand 제거 →
                Tailwind text size + font-weight 유틸리티. */}
            <h2 className="m-0 text-[length:var(--fs-18)] font-semibold">
              {section === 'general'
                ? '일반'
                : section === 'permissions'
                  ? '권한'
                  : section === 'moderation'
                    ? '메시지 관리'
                    : ''}
            </h2>
          </header>

          {section === 'general' ? (
            <GeneralSection
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              channel={channel}
            />
          ) : section === 'permissions' ? (
            <ChannelPermissionsTab workspaceId={workspaceId} channelId={channel.id} />
          ) : section === 'moderation' ? (
            <BulkPurgeSection
              workspaceId={workspaceId}
              channelId={channel.id}
              channelName={channel.name}
            />
          ) : null}
        </section>

        {deleteOpen ? (
          <Dialog
            open={deleteOpen}
            onOpenChange={(v) => {
              if (!v) setDeleteOpen(false);
            }}
            title="채널을 삭제할까요?"
            description={`#${channel.name} 채널의 모든 메시지가 사라지며, 되돌릴 수 없습니다.`}
          >
            <div className="qf-modal__footer">
              <Button type="button" variant="ghost" onClick={() => setDeleteOpen(false)}>
                취소
              </Button>
              <Button
                type="button"
                variant="danger"
                data-testid="channel-settings-delete-confirm"
                onClick={() => {
                  // Mutation + navigation handled inline so we can close the
                  // dialog synchronously on optimistic dispatch.
                  setDeleteOpen(false);
                  void (async () => {
                    try {
                      await deleteMut.mutateAsync(channel.id);
                      notify({
                        variant: 'success',
                        title: '채널 삭제됨',
                        body: `#${channel.name} 이(가) 삭제되었습니다.`,
                      });
                      navigate(`/w/${workspaceSlug}`);
                    } catch (err) {
                      notify({
                        variant: 'danger',
                        title: '채널 삭제 실패',
                        body: (err as Error).message,
                      });
                    }
                  })();
                }}
              >
                삭제하기
              </Button>
            </div>
          </Dialog>
        ) : null}
      </div>
    </SettingsOverlay>
  );
}

function GeneralSection({
  workspaceId,
  workspaceSlug,
  channel,
}: {
  workspaceId: string;
  workspaceSlug: string;
  channel: Channel & { name: string };
}): JSX.Element {
  const navigate = useNavigate();
  const notify = useNotifications((s) => s.push);
  const updateMut = useUpdateChannel(workspaceId);
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  // S13 (FR-CH-10): 채널 설명(≤500자). 토픽과 별개의 긴 소개 텍스트.
  const [description, setDescription] = useState(channel.description ?? '');
  // S15 (FR-CH-08): 슬로우모드 간격(초). 0=비활성.
  const [slowmodeSeconds, setSlowmodeSeconds] = useState<number>(channel.slowmodeSeconds ?? 0);
  // S51 (FR-PS-05): 핀 권한 토글. true=멤버 전체 허용, false=관리자만. 즉시 PATCH 한다
  // (공개범위 토글과 동일하게 별도 저장 버튼 없이 토글 즉시 반영).
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // S14 (FR-CH-05): 공개/비공개 전환. 비공개→공개는 2단계 confirm 모달을 거친다.
  const [privacyConfirmOpen, setPrivacyConfirmOpen] = useState(false);
  const [privacySubmitting, setPrivacySubmitting] = useState(false);

  // 공개→비공개: 토큰 불요, 즉시 전환. 비공개→공개: confirm 모달 오픈.
  const togglePrivacy = (): void => {
    if (channel.isPrivate) {
      setPrivacyConfirmOpen(true);
      return;
    }
    void (async () => {
      setPrivacySubmitting(true);
      try {
        await updateMut.mutateAsync({ id: channel.id, patch: { isPrivate: true } });
        notify({
          variant: 'success',
          title: '비공개로 전환됨',
          body: '이제 초대받은 멤버만 볼 수 있어요.',
        });
      } catch (err) {
        notify({ variant: 'danger', title: '전환 실패', body: (err as Error).message });
      } finally {
        setPrivacySubmitting(false);
      }
    })();
  };

  // S51 (FR-PS-05): 핀 권한 토글. memberCanPin 을 반전해 즉시 PATCH 한다.
  const togglePinPermission = (): void => {
    void (async () => {
      setPinSubmitting(true);
      const next = !channel.memberCanPin;
      try {
        await updateMut.mutateAsync({ id: channel.id, patch: { memberCanPin: next } });
        notify({
          variant: 'success',
          title: next ? '멤버 전체 허용' : '관리자만 고정',
          body: next
            ? '이제 채널 멤버 누구나 메시지를 고정할 수 있어요.'
            : '이제 관리자만 메시지를 고정할 수 있어요.',
        });
      } catch (err) {
        notify({ variant: 'danger', title: '변경 실패', body: (err as Error).message });
      } finally {
        setPinSubmitting(false);
      }
    })();
  };

  const confirmGoPublic = (confirmName: string): void => {
    void (async () => {
      setPrivacySubmitting(true);
      try {
        await updateMut.mutateAsync({ id: channel.id, patch: { isPrivate: false, confirmName } });
        notify({
          variant: 'success',
          title: '공개로 전환됨',
          body: '이제 모든 멤버가 볼 수 있어요.',
        });
        setPrivacyConfirmOpen(false);
      } catch (err) {
        notify({ variant: 'danger', title: '전환 실패', body: (err as Error).message });
      } finally {
        setPrivacySubmitting(false);
      }
    })();
  };

  const dirty =
    name.trim() !== channel.name ||
    (topic.trim() || null) !== (channel.topic || null) ||
    (description.trim() || null) !== (channel.description || null) ||
    slowmodeSeconds !== (channel.slowmodeSeconds ?? 0);
  const canSave = !submitting && dirty && name.trim().length > 0;

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSubmitting(true);
    try {
      const newName = name.trim();
      await updateMut.mutateAsync({
        id: channel.id,
        patch: {
          ...(newName !== channel.name ? { name: newName } : {}),
          ...((topic.trim() || null) !== (channel.topic || null)
            ? { topic: topic.trim() || null }
            : {}),
          ...((description.trim() || null) !== (channel.description || null)
            ? { description: description.trim() || null }
            : {}),
          // S15 (FR-CH-08): slowmodeSeconds 변경분만 전송.
          ...(slowmodeSeconds !== (channel.slowmodeSeconds ?? 0) ? { slowmodeSeconds } : {}),
        },
      });
      notify({ variant: 'success', title: '저장됨', body: '채널 설정이 업데이트됐어요.' });
      // If the slug-like name changed, the current URL's :channel
      // segment points at the old value — replace it so subsequent
      // settings sub-navigation stays on the right channel.
      if (newName !== channel.name) {
        navigate(`/w/${workspaceSlug}/${newName}/settings`, { replace: true });
      }
    } catch (err) {
      notify({
        variant: 'danger',
        title: '저장 실패',
        body: (err as Error).message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      data-testid="channel-settings-general"
      className="flex flex-col gap-[var(--s-5)]"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="qf-field">
        <label className="qf-field__label" htmlFor="channel-settings-name">
          채널 이름
        </label>
        <Input
          id="channel-settings-name"
          data-testid="channel-settings-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: general"
          maxLength={80}
        />
        <p className="qf-field__hint">공백 대신 하이픈(-)을 쓰면 깔끔해 보여요.</p>
      </div>
      <div className="qf-field">
        <label className="qf-field__label" htmlFor="channel-settings-topic">
          토픽 <span className="text-text-muted">(선택)</span>
        </label>
        <Input
          id="channel-settings-topic"
          data-testid="channel-settings-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="예: 공지 · 일반 대화"
          maxLength={1024}
        />
        <p className="qf-field__hint">채널 상단 제목 옆에 표시됩니다.</p>
      </div>
      {/* S13 (FR-CH-10): 채널 설명 — 채널 브라우저/소개에 노출되는 ≤500자 텍스트. */}
      <div className="qf-field">
        <label className="qf-field__label" htmlFor="channel-settings-description">
          채널 설명 <span className="text-text-muted">(선택)</span>
        </label>
        <textarea
          id="channel-settings-description"
          data-testid="channel-settings-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="이 채널은 어떤 곳인지 소개해 주세요."
          maxLength={500}
          rows={3}
          className="qf-input resize-none"
        />
        <p className="qf-field__hint">채널 브라우저 목록에 표시됩니다. 최대 500자.</p>
      </div>
      {/* S15 (FR-CH-08): 슬로우모드 — 멤버가 메시지 사이에 기다려야 하는 간격. */}
      <div className="qf-field">
        <label className="qf-field__label" htmlFor="channel-settings-slowmode">
          슬로우모드 <span className="text-text-muted">(선택)</span>
        </label>
        <select
          id="channel-settings-slowmode"
          data-testid="channel-settings-slowmode"
          value={slowmodeSeconds}
          onChange={(e) => setSlowmodeSeconds(Number(e.target.value))}
          className="qf-input"
        >
          {SLOWMODE_OPTIONS.map((opt) => (
            <option key={opt.seconds} value={opt.seconds}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="qf-field__hint">
          관리자는 슬로우모드의 영향을 받지 않습니다. 끄려면 “비활성”을 선택하세요.
        </p>
      </div>
      {/* S14 (FR-CH-05): 공개/비공개 전환. 비공개→공개는 confirm 모달을 거친다. */}
      <div className="qf-field">
        <span className="qf-field__label">공개 범위</span>
        <div className="flex items-center justify-between gap-[var(--s-4)]">
          <p className="qf-field__hint m-0">
            {channel.isPrivate
              ? '비공개 채널 — 초대받은 멤버만 볼 수 있어요.'
              : '공개 채널 — 워크스페이스의 모든 멤버가 볼 수 있어요.'}
          </p>
          <Button
            type="button"
            variant="secondary"
            data-testid="channel-settings-privacy-toggle"
            disabled={privacySubmitting}
            onClick={togglePrivacy}
          >
            {channel.isPrivate ? '공개로 전환' : '비공개로 전환'}
          </Button>
        </div>
      </div>
      {/* S51 (FR-PS-05): 핀 권한 — 멤버 전체 허용 vs 관리자만. 즉시 토글. */}
      <div className="qf-field">
        <span className="qf-field__label">핀 권한</span>
        <div className="flex items-center justify-between gap-[var(--s-4)]">
          {/* S51 리뷰(a11y B-03): 현재 핀 권한 상태를 안내하는 hint 를
              토글 버튼에 aria-describedby 로 연결해 SR 이 동작 직전에 현재
              상태를 함께 읽게 한다(상태가 기계 판독 불가했던 문제 해소). */}
          <p id="channel-pin-perm-hint" className="qf-field__hint m-0">
            {channel.memberCanPin
              ? '채널 멤버 누구나 메시지를 고정할 수 있어요.'
              : '관리자만 메시지를 고정할 수 있어요.'}
          </p>
          <Button
            type="button"
            variant="secondary"
            data-testid="channel-settings-pin-permission-toggle"
            aria-describedby="channel-pin-perm-hint"
            disabled={pinSubmitting}
            onClick={togglePinPermission}
          >
            {channel.memberCanPin ? '관리자만 고정으로 변경' : '멤버 전체 허용으로 변경'}
          </Button>
        </div>
      </div>
      <div className={cn('mt-[var(--s-2)]', !dirty && 'opacity-0 pointer-events-none')}>
        <Button
          type="submit"
          variant="primary"
          data-testid="channel-settings-save"
          disabled={!canSave}
        >
          {submitting ? '저장 중…' : '저장하기'}
        </Button>
      </div>
      <ChannelPrivacyConfirmModal
        open={privacyConfirmOpen}
        channelName={channel.name}
        submitting={privacySubmitting}
        onConfirm={confirmGoPublic}
        onCancel={() => setPrivacyConfirmOpen(false)}
      />
    </form>
  );
}

/**
 * S64 (D12 / FR-RM09): bulk purge 섹션. 채널 최신 N개 메시지를 일괄 soft-delete 한다
 * (단일 updateMany + 단일 message:bulk_deleted 이벤트). 서버가 MANAGE_MESSAGES 비트를
 * 강제하므로 권한 없는 사용자는 403 을 받는다(UI 는 안내만). 파괴적 작업이라 confirm
 * 모달(alertDialog)을 거친다. DS qf-* + 토큰만 사용(raw hex/px 금지).
 */
function BulkPurgeSection({
  workspaceId,
  channelId,
  channelName,
}: {
  workspaceId: string;
  channelId: string;
  channelName: string;
}): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const [count, setCount] = useState<number>(10);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const clamped = Math.max(1, Math.min(BULK_DELETE_MAX, Math.floor(count) || 1));

  const doPurge = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const res = await bulkDeleteMessages(workspaceId, channelId, { latest: clamped });
      notify({
        variant: 'success',
        title: '메시지 일괄 삭제 완료',
        body: `${res.deletedCount}개의 메시지를 삭제했습니다.`,
      });
    } catch (e) {
      const code = (e as { errorCode?: string } | undefined)?.errorCode;
      notify({
        variant: 'danger',
        title: '일괄 삭제 실패',
        body: code === 'FORBIDDEN' ? '메시지 관리 권한이 필요합니다.' : (e as Error).message,
      });
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="flex flex-col gap-[var(--s-4)]" data-testid="bulk-purge-section">
      <p className="text-[length:var(--fs-13)] text-text-secondary">
        채널의 최신 메시지를 한 번에 삭제합니다(최대 {BULK_DELETE_MAX}개). 삭제된 메시지는 되돌릴 수
        없습니다.
      </p>
      <div className="qf-field max-w-xs">
        <label className="qf-field__label" htmlFor="bulk-purge-count">
          삭제할 최신 메시지 수
        </label>
        <Input
          id="bulk-purge-count"
          data-testid="bulk-purge-count"
          type="number"
          min={1}
          max={BULK_DELETE_MAX}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
        />
      </div>
      <div>
        <Button
          variant="danger"
          data-testid="bulk-purge-open"
          disabled={submitting}
          onClick={() => setConfirmOpen(true)}
        >
          최신 {clamped}개 삭제
        </Button>
      </div>

      {confirmOpen ? (
        <Dialog
          open={confirmOpen}
          onOpenChange={(v) => {
            if (!v) setConfirmOpen(false);
          }}
          title="메시지를 일괄 삭제할까요?"
          description={`#${channelName} 채널의 최신 ${clamped}개 메시지가 삭제되며, 되돌릴 수 없습니다.`}
          alertDialog
        >
          <div className="qf-modal__footer">
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              취소
            </Button>
            <Button
              type="button"
              variant="danger"
              data-testid="bulk-purge-confirm"
              disabled={submitting}
              onClick={() => void doPurge()}
            >
              {submitting ? '삭제 중…' : '삭제하기'}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
