import { useEffect, useRef, useState } from 'react';
import { Dialog, Button, Input, Icon } from '../../design-system/primitives';
import type { IconName } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useCreateChannel } from './useChannels';
import { cn } from '../../lib/cn';

type Props = {
  workspaceId: string;
  /** null = default "채널" group (no category). */
  categoryId: string | null;
  /** Display name of the target category, for the dialog description. */
  categoryLabel: string;
  open: boolean;
  onClose: () => void;
};

type ChannelKind = 'TEXT' | 'ANNOUNCEMENT';

const TYPE_OPTIONS: { v: ChannelKind; label: string; icon: IconName; desc: string }[] = [
  { v: 'TEXT', label: '텍스트', icon: 'hash', desc: '모두가 메시지를 보냅니다' },
  { v: 'ANNOUNCEMENT', label: '공지', icon: 'megaphone', desc: '권한자만 게시' },
];

/**
 * Task-020 + 072-N3-1: 채널 생성 모달. 종전엔 type=TEXT 하드코딩 + '설명' 라벨이
 * topic 에 바인딩(description 미사용)이었다. PRD(FR-CH-01/09/10)에 맞춰:
 *  - 타입 라디오(텍스트/공지)
 *  - 비공개 채널 토글(qf-switch → isPrivate)
 *  - topic(헤더 표시) / description(둘러보기 설명) 필드 분리
 * 를 노출한다. 계약(CreateChannelRequest)은 이미 네 필드를 모두 받는다.
 */
export function CreateChannelModal({
  workspaceId,
  categoryId,
  categoryLabel,
  open,
  onClose,
}: Props): JSX.Element | null {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ChannelKind>('TEXT');
  const [isPrivate, setIsPrivate] = useState(false);
  const [topic, setTopic] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotifications((s) => s.push);
  const createMut = useCreateChannel(workspaceId);
  const radioRefs = useRef<Record<ChannelKind, HTMLButtonElement | null>>({
    TEXT: null,
    ANNOUNCEMENT: null,
  });
  const moveType = (idx: number, dir: number): void => {
    const next = TYPE_OPTIONS[(idx + dir + TYPE_OPTIONS.length) % TYPE_OPTIONS.length];
    setKind(next.v);
    radioRefs.current[next.v]?.focus();
  };

  useEffect(() => {
    if (open) {
      setName('');
      setKind('TEXT');
      setIsPrivate(false);
      setTopic('');
      setDescription('');
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  // 072-N3(리뷰 LOW): 계약(ChannelNameSchema: 소문자 alphanum/_/- · ≤32)을 클라에서
  // 강제해 서버 raw-zod 토스트 대신 인라인 안내. 입력 maxLength 도 32 로 맞춘다.
  const trimmedName = name.trim();
  const nameValid = /^[a-z0-9][a-z0-9_-]*$/.test(trimmedName) && trimmedName.length <= 32;
  const showNameError = trimmedName.length > 0 && !nameValid;
  const canSubmit = !submitting && nameValid;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const trimmedTopic = topic.trim();
      const trimmedDesc = description.trim();
      await createMut.mutateAsync({
        name: name.trim(),
        type: kind,
        categoryId: categoryId ?? undefined,
        isPrivate,
        ...(trimmedTopic ? { topic: trimmedTopic } : {}),
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
      });
      onClose();
    } catch (err) {
      notify({
        variant: 'danger',
        title: '채널 생성 실패',
        body: (err as Error).message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="채널 만들기"
      description={`${categoryLabel} 아래에 새 채널을 추가합니다.`}
    >
      <form
        data-testid="create-channel-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* N3-1 (FR-CH-01): 채널 타입 — 텍스트 / 공지. 072-N3(리뷰 HIGH): ARIA radio
            패턴 — roving tabindex(선택만 tab 진입) + 화살표로 이동·선택. */}
        <fieldset className="qf-field">
          <legend className="qf-field__label">채널 유형</legend>
          <div role="radiogroup" aria-label="채널 유형" className="flex gap-[var(--s-2)]">
            {TYPE_OPTIONS.map((opt, idx) => (
              <button
                key={opt.v}
                ref={(el) => {
                  radioRefs.current[opt.v] = el;
                }}
                type="button"
                role="radio"
                aria-checked={kind === opt.v}
                tabIndex={kind === opt.v ? 0 : -1}
                data-testid={`create-channel-type-${opt.v.toLowerCase()}`}
                onClick={() => setKind(opt.v)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    moveType(idx, +1);
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    moveType(idx, -1);
                  }
                }}
                className={cn(
                  'flex flex-1 items-start gap-[var(--s-2)] rounded-[var(--r-md)] border p-[var(--s-3)] text-left',
                  kind === opt.v
                    ? 'border-[var(--accent)] bg-[var(--bg-selected)]'
                    : 'border-[var(--divider)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <Icon name={opt.icon} size="sm" aria-hidden className="shrink-0" />
                <span className="flex flex-col">
                  <span className="text-[length:var(--fs-13)] font-semibold text-text-strong">
                    {opt.label}
                  </span>
                  <span className="text-[length:var(--fs-12)] text-text-muted">{opt.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="qf-field">
          <label className="qf-field__label" htmlFor="create-channel-name">
            채널 이름
          </label>
          <Input
            id="create-channel-name"
            data-testid="create-channel-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: general"
            maxLength={32}
            aria-invalid={showNameError || undefined}
            aria-describedby="create-channel-name-hint"
          />
          {showNameError ? (
            <p
              id="create-channel-name-hint"
              data-testid="create-channel-name-error"
              role="alert"
              className="qf-field__hint text-[color:var(--danger)]"
            >
              소문자·숫자·하이픈(-)·밑줄(_)만, 32자 이내로 입력해주세요.
            </p>
          ) : (
            <p id="create-channel-name-hint" className="qf-field__hint">
              공백 대신 하이픈(-)을 쓰면 깔끔해 보여요. (소문자·숫자·- · _)
            </p>
          )}
        </div>

        {/* N3-1 (FR-CH-09): 헤더에 표시되는 토픽. */}
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="create-channel-topic">
            토픽 <span className="text-text-muted">(선택)</span>
          </label>
          <Input
            id="create-channel-topic"
            data-testid="create-channel-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="예: 공지 · 일반 대화"
            maxLength={1024}
          />
          <p className="qf-field__hint">채널 상단 제목 옆에 표시됩니다.</p>
        </div>

        {/* N3-1 (FR-CH-10): 둘러보기 목록에 표시되는 설명. */}
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="create-channel-description">
            설명 <span className="text-text-muted">(선택)</span>
          </label>
          <textarea
            id="create-channel-description"
            data-testid="create-channel-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="채널 둘러보기에서 이 채널을 소개합니다."
            maxLength={500}
            rows={2}
            className="qf-input w-full resize-none"
          />
        </div>

        {/* N3-1 (FR-CH-01): 비공개 채널 토글. */}
        <div className="qf-toggle-row" style={{ borderBottom: 'none', padding: 'var(--s-2) 0' }}>
          <div className="qf-toggle-row__text">
            <div className="qf-toggle-row__title" id="create-channel-private-label">
              비공개 채널
            </div>
            <div className="qf-toggle-row__desc">초대된 멤버와 권한자만 볼 수 있습니다.</div>
          </div>
          <button
            type="button"
            role="switch"
            data-testid="create-channel-private"
            className="qf-switch"
            aria-checked={isPrivate}
            aria-labelledby="create-channel-private-label"
            onClick={() => setIsPrivate((v) => !v)}
          />
        </div>

        <div className="qf-modal__footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button
            type="submit"
            data-testid="create-channel-submit"
            disabled={!canSubmit}
            variant="primary"
          >
            {submitting ? '만드는 중…' : '만들기'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
