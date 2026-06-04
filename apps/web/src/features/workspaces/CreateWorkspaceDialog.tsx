import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CreateWorkspaceRequest,
  CreateWorkspaceRequestSchema,
  WORKSPACE_CATEGORY_META,
  type WorkspaceCategory,
  type WorkspaceJoinMode,
} from '@qufox/shared-types';
import { Button, Dialog, Input } from '../../design-system/primitives';
import { useCreateWorkspace } from './useWorkspaces';

/**
 * Workspace creation surface. Previously a standalone page at
 * `/w/new`; now a DS Dialog that any caller can open in place (server
 * rail "+" button, legacy /w/new deep-link wrapper, settings dropdown,
 * etc.). No forced-create-on-signup flow uses this anymore — it is
 * strictly opt-in.
 *
 * UI choices (2026-04-23 follow):
 *   - visibility → qf-switch toggle (aria-checked role=switch) instead
 *     of a radio/checkbox pair; label text clarifies "공개 여부".
 *   - description textarea is always visible; schema still requires
 *     non-empty text for PUBLIC workspaces, so server-side validation
 *     prevents empty public entries. For PRIVATE the user can now add
 *     a description voluntarily.
 *   - category select stays gated to PUBLIC because the schema rejects
 *     PRIVATE-with-category.
 */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { mutateAsync, isPending } = useCreateWorkspace();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  // S65 (FR-W01): 가입 방식(visibility 와 직교) + 이메일 도메인 화이트리스트.
  // joinMode 는 폼 상태로 직접 관리하고, emailDomains 는 콤마/공백 구분 텍스트를
  // 제출 시 배열로 정규화한다(빈 입력 = 제한 없음).
  const [joinMode, setJoinMode] = useState<WorkspaceJoinMode>('PRIVATE');
  const [emailDomainsText, setEmailDomainsText] = useState('');
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<CreateWorkspaceRequest>({ resolver: zodResolver(CreateWorkspaceRequestSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    // S65 (FR-W01): 텍스트 → 도메인 배열. 콤마/공백/줄바꿈 구분, 소문자, 빈 토큰 제거.
    const emailDomains = emailDomainsText
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);
    try {
      const ws = await mutateAsync({
        ...values,
        joinMode,
        ...(emailDomains.length > 0 ? { emailDomains } : {}),
      });
      reset();
      setIsPublic(false);
      setJoinMode('PRIVATE');
      setEmailDomainsText('');
      onOpenChange(false);
      navigate(`/w/${ws.slug}`);
    } catch (e) {
      setServerError((e as Error).message);
    }
  });

  const togglePublic = (next: boolean): void => {
    setIsPublic(next);
    setValue('visibility', next ? 'PUBLIC' : 'PRIVATE', { shouldValidate: true });
    if (!next) {
      setValue('category', undefined, { shouldValidate: true });
    }
  };

  const descriptionLen = (watch('description') ?? '').length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setIsPublic(false);
          setJoinMode('PRIVATE');
          setEmailDomainsText('');
          setServerError(null);
        }
        onOpenChange(next);
      }}
      title="새 워크스페이스"
      description="이름과 slug를 정하고, 공개 여부는 토글로 선택하세요."
      className="w-[min(520px,92vw)]"
    >
      <form className="flex flex-col gap-[var(--s-5)]" onSubmit={onSubmit}>
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="ws-name">
            이름
          </label>
          <Input
            id="ws-name"
            data-testid="ws-name"
            type="text"
            invalid={!!errors.name}
            {...register('name')}
          />
          {errors.name && <p className="qf-field__error">{errors.name.message}</p>}
        </div>
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="ws-slug">
            Slug
          </label>
          <Input
            id="ws-slug"
            data-testid="ws-slug"
            type="text"
            invalid={!!errors.slug}
            {...register('slug')}
          />
          {errors.slug && <p className="qf-field__error">{errors.slug.message}</p>}
        </div>

        <div className="qf-field" data-testid="ws-description-field">
          <label className="qf-field__label" htmlFor="ws-description">
            설명{' '}
            <span className="text-text-muted">
              {isPublic ? `(공개 시 필수, ${descriptionLen}/500)` : `(선택, ${descriptionLen}/500)`}
            </span>
          </label>
          <textarea
            id="ws-description"
            data-testid="ws-description"
            rows={3}
            maxLength={500}
            className="qf-input"
            {...register('description')}
          />
          {errors.description && <p className="qf-field__error">{errors.description.message}</p>}
        </div>

        <div className="qf-toggle-row">
          <div className="qf-toggle-row__text">
            <div className="qf-toggle-row__title">공개 여부</div>
            <div className="qf-toggle-row__desc">
              {isPublic
                ? 'ON — /찾기에 노출되며 누구나 참가할 수 있습니다.'
                : 'OFF — 초대받은 사람만 참가할 수 있습니다.'}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isPublic}
            data-testid="ws-visibility-public"
            onClick={() => togglePublic(!isPublic)}
            className="qf-switch"
          />
        </div>

        <div className="qf-field" data-testid="ws-join-mode-field">
          <label className="qf-field__label" htmlFor="ws-join-mode">
            가입 방식
          </label>
          <select
            id="ws-join-mode"
            data-testid="ws-join-mode"
            className="qf-input"
            value={joinMode}
            onChange={(e) => setJoinMode(e.target.value as WorkspaceJoinMode)}
          >
            <option value="PRIVATE">초대 전용 (PRIVATE)</option>
            <option value="PUBLIC">즉시 가입 (PUBLIC)</option>
            <option value="APPLY">신청 후 승인 (APPLY)</option>
          </select>
          <p className="text-[length:var(--fs-12)] text-text-muted">
            가입 방식은 공개 여부와 별개입니다.
          </p>
        </div>

        <div className="qf-field" data-testid="ws-email-domains-field">
          <label className="qf-field__label" htmlFor="ws-email-domains">
            이메일 도메인 화이트리스트 <span className="text-text-muted">(선택)</span>
          </label>
          <Input
            id="ws-email-domains"
            data-testid="ws-email-domains"
            type="text"
            placeholder="example.com, corp.io"
            value={emailDomainsText}
            onChange={(e) => setEmailDomainsText(e.target.value)}
          />
          <p className="text-[length:var(--fs-12)] text-text-muted">
            콤마 또는 공백으로 구분합니다. 비우면 제한이 없습니다.
          </p>
        </div>

        {isPublic ? (
          <div className="qf-field" data-testid="ws-category-field">
            <label className="qf-field__label" htmlFor="ws-category">
              카테고리 <span className="text-text-muted">(공개 시 필수)</span>
            </label>
            <select
              id="ws-category"
              data-testid="ws-category"
              className="qf-input"
              {...register('category')}
              defaultValue=""
            >
              <option value="" disabled>
                선택…
              </option>
              {(Object.keys(WORKSPACE_CATEGORY_META) as WorkspaceCategory[]).map((k) => (
                <option key={k} value={k}>
                  {WORKSPACE_CATEGORY_META[k].label}
                </option>
              ))}
            </select>
            {errors.category && <p className="qf-field__error">{errors.category.message}</p>}
          </div>
        ) : null}

        {serverError && (
          <p data-testid="ws-create-error" className="qf-field__error">
            {serverError}
          </p>
        )}
        <div className="flex gap-[var(--s-2)] justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            취소
          </Button>
          <Button data-testid="ws-create-submit" type="submit" disabled={isPending}>
            {isPending ? '만드는 중…' : '워크스페이스 만들기'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
