import { useState } from 'react';
import type { CreateInviteRequest } from '@qufox/shared-types';
import { Button, Dialog } from '../../design-system/primitives';
import { useCreateInvite } from './useWorkspaces';

// S67 (D13 / FR-W02): 만료 옵션(30분~무제한). value=null 이면 만료 없음(never).
const EXPIRY_OPTIONS: Array<{ label: string; minutes: number | null }> = [
  { label: '30분', minutes: 30 },
  { label: '1시간', minutes: 60 },
  { label: '6시간', minutes: 360 },
  { label: '1일', minutes: 1440 },
  { label: '7일', minutes: 10080 },
  { label: '30일', minutes: 43200 },
  { label: '무제한', minutes: null },
];

// S67 (D13 / FR-W02): 최대 사용 횟수 옵션. value=null 이면 무제한.
const MAX_USES_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: '1회', value: 1 },
  { label: '5회', value: 5 },
  { label: '10회', value: 10 },
  { label: '25회', value: 25 },
  { label: '무제한', value: null },
];

export function CreateInviteModal({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const create = useCreateInvite(workspaceId);
  // 기본값: 7일 만료 · 무제한 사용 · 영구 멤버.
  const [expiryMinutes, setExpiryMinutes] = useState<number | null>(10080);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [temporary, setTemporary] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = (): void => {
    setExpiryMinutes(10080);
    setMaxUses(null);
    setTemporary(false);
    setErr(null);
  };

  const onCreate = async (): Promise<void> => {
    setErr(null);
    const body: CreateInviteRequest = { temporary };
    if (expiryMinutes !== null) {
      body.expiresAt = new Date(Date.now() + expiryMinutes * 60_000).toISOString();
    }
    if (maxUses !== null) {
      body.maxUses = maxUses;
    }
    try {
      await create.mutateAsync(body);
      reset();
      onOpenChange(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="초대 링크 만들기"
      description="만료 시간·최대 사용 횟수·임시 멤버십을 설정해 코드를 발급합니다."
      className="w-[min(420px,92vw)]"
    >
      <div data-testid="create-invite-form" className="flex flex-col gap-[var(--s-5)]">
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="invite-expiry">
            만료
          </label>
          <select
            id="invite-expiry"
            data-testid="invite-expiry"
            className="qf-input"
            value={expiryMinutes === null ? 'never' : String(expiryMinutes)}
            onChange={(e) =>
              setExpiryMinutes(e.target.value === 'never' ? null : Number(e.target.value))
            }
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.label} value={o.minutes === null ? 'never' : String(o.minutes)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="qf-field">
          <label className="qf-field__label" htmlFor="invite-max-uses">
            최대 사용 횟수
          </label>
          <select
            id="invite-max-uses"
            data-testid="invite-max-uses"
            className="qf-input"
            value={maxUses === null ? 'unlimited' : String(maxUses)}
            onChange={(e) =>
              setMaxUses(e.target.value === 'unlimited' ? null : Number(e.target.value))
            }
          >
            {MAX_USES_OPTIONS.map((o) => (
              <option key={o.label} value={o.value === null ? 'unlimited' : String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-[var(--s-3)] text-[length:var(--fs-13)]">
          <input
            type="checkbox"
            aria-label="임시 멤버십"
            data-testid="invite-temporary"
            checked={temporary}
            onChange={(e) => setTemporary(e.target.checked)}
          />
          <span>
            임시 멤버십{' '}
            <span className="text-text-muted">— 연결이 끊기면 자동으로 내보냅니다.</span>
          </span>
        </label>

        {err ? (
          <p className="qf-field__error" data-testid="create-invite-error" role="alert">
            {err}
          </p>
        ) : null}

        <div className="flex gap-[var(--s-2)] justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            data-testid="create-invite-submit"
            onClick={onCreate}
            disabled={create.isPending}
            aria-busy={create.isPending || undefined}
          >
            {create.isPending ? '만드는 중…' : '링크 만들기'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
