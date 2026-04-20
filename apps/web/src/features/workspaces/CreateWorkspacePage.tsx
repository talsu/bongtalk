import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CreateWorkspaceRequest, CreateWorkspaceRequestSchema } from '@qufox/shared-types';
import { Button, Input } from '../../design-system/primitives';
import { useCreateWorkspace } from './useWorkspaces';

export function CreateWorkspacePage(): JSX.Element {
  const navigate = useNavigate();
  const { mutateAsync, isPending } = useCreateWorkspace();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
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
          이름과 slug를 선택하세요. 동료 초대는 다음 단계에서 진행합니다.
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
          <div className="qf-field">
            <label className="qf-field__label">Description</label>
            <Input data-testid="ws-description" type="text" {...register('description')} />
          </div>
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
