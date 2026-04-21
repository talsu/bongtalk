import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Channel } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { Dialog, Button, Input } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useDeleteChannel, useUpdateChannel } from './useChannels';

type SectionId = 'general';

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
    { type: 'action', id: 'delete', label: '채널 삭제', danger: true },
  ];

  const closeSettings = (): void => {
    navigate(`/w/${workspaceSlug}/${channel.name}`);
  };

  return (
    <main
      data-testid="channel-settings"
      className="qf-settings"
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
                aria-selected={active}
                onClick={() => navigate(`/w/${workspaceSlug}/${channel.name}/settings/${item.id}`)}
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
              className="qf-settings__nav-item w-full text-left"
              style={{ color: 'var(--danger-400)' }}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <section className="qf-settings__main">
        <header className="mb-[var(--s-5)] flex items-center justify-between">
          <h2 className="m-0" style={{ font: '600 var(--fs-18) var(--font-sans)' }}>
            {section === 'general' ? '일반' : ''}
          </h2>
          <button
            type="button"
            data-testid="channel-settings-close"
            aria-label="설정 닫기"
            onClick={closeSettings}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            ✕
          </button>
        </header>

        {section === 'general' ? (
          <GeneralSection
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            channel={channel}
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
    </main>
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
  const [submitting, setSubmitting] = useState(false);

  const dirty = name.trim() !== channel.name || (topic.trim() || null) !== (channel.topic || null);
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
          설명 <span className="text-text-muted">(선택)</span>
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
    </form>
  );
}
