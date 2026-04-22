import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CreateWorkspaceRequest,
  CreateWorkspaceRequestSchema,
  WORKSPACE_CATEGORY_META,
  type WorkspaceCategory,
} from '@qufox/shared-types';
import { Button, Input } from '../../design-system/primitives';
import { useCreateWorkspace } from './useWorkspaces';

export function CreateWorkspacePage(): JSX.Element {
  const navigate = useNavigate();
  const { mutateAsync, isPending } = useCreateWorkspace();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateWorkspaceRequest>({ resolver: zodResolver(CreateWorkspaceRequestSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      const ws = await mutateAsync(values);
      navigate(`/w/${ws.slug}`, { replace: true });
    } catch (e) {
      setServerError((e as Error).message);
    }
  });

  // task-030-D: visibility toggle drives category + description required-ness.
  const togglePublic = (next: boolean): void => {
    setIsPublic(next);
    setValue('visibility', next ? 'PUBLIC' : 'PRIVATE', { shouldValidate: true });
    if (!next) {
      setValue('category', undefined, { shouldValidate: true });
    }
  };

  const descriptionLen = (watch('description') ?? '').length;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-[var(--s-6)]">
      <section
        className="w-full max-w-md p-[var(--s-9)]"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-2)',
        }}
      >
        <div className="qf-eyebrow mb-[var(--s-3)]">new workspace</div>
        <h1 className="text-[var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
          새 워크스페이스
        </h1>
        <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
          이름과 slug를 선택하세요. 공개 워크스페이스는 카테고리 + 설명이 필요합니다.
        </p>
        <form className="mt-[var(--s-7)] flex flex-col gap-[var(--s-5)]" onSubmit={onSubmit}>
          <div className="qf-field">
            <label className="qf-field__label">Name</label>
            <Input
              data-testid="ws-name"
              type="text"
              invalid={!!errors.name}
              {...register('name')}
            />
            {errors.name && <p className="qf-field__error">{errors.name.message}</p>}
          </div>
          <div className="qf-field">
            <label className="qf-field__label">Slug</label>
            <Input
              data-testid="ws-slug"
              type="text"
              invalid={!!errors.slug}
              {...register('slug')}
            />
            {errors.slug && <p className="qf-field__error">{errors.slug.message}</p>}
          </div>

          {/* task-030-D field 1: visibility toggle */}
          <div className="qf-field">
            <label className="qf-field__label" htmlFor="ws-visibility-toggle">
              공개 설정
            </label>
            <div className="flex items-center gap-[var(--s-3)]">
              <input
                id="ws-visibility-toggle"
                data-testid="ws-visibility-public"
                type="checkbox"
                checked={isPublic}
                onChange={(e) => togglePublic(e.target.checked)}
              />
              <span className="text-[length:var(--fs-13)]">
                {isPublic ? '공개 (PUBLIC) — 누구나 찾고 참가 가능' : '비공개 (PRIVATE) — 초대만'}
              </span>
            </div>
          </div>

          {/* task-030-D field 2: category selector — only when PUBLIC */}
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

          {/* task-030-D field 3: description textarea — 500 chars, required when PUBLIC */}
          {isPublic ? (
            <div className="qf-field" data-testid="ws-description-field">
              <label className="qf-field__label" htmlFor="ws-description">
                설명 <span className="text-text-muted">(공개 시 필수, {descriptionLen}/500)</span>
              </label>
              <textarea
                id="ws-description"
                data-testid="ws-description"
                rows={3}
                maxLength={500}
                className="qf-input"
                {...register('description')}
              />
              {errors.description && (
                <p className="qf-field__error">{errors.description.message}</p>
              )}
            </div>
          ) : (
            <div className="qf-field" style={{ display: 'none' }} aria-hidden>
              {/* Hidden when PRIVATE — 사용자 요구사항: "공개 OFF 시 필드 display:none" */}
              <input
                data-testid="ws-description-hidden"
                type="hidden"
                {...register('description')}
              />
            </div>
          )}

          {serverError && (
            <p data-testid="ws-create-error" className="qf-field__error">
              {serverError}
            </p>
          )}
          <Button
            data-testid="ws-create-submit"
            type="submit"
            disabled={isPending}
            size="lg"
            className="w-full"
          >
            {isPending ? '만드는 중…' : '워크스페이스 만들기'}
          </Button>
        </form>
      </section>
    </main>
  );
}
