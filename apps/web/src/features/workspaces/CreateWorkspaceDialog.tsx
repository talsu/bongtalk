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
import { Button, Dialog, Icon, Input } from '../../design-system/primitives';
import { useIsMobile } from '../../lib/useBreakpoint';
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
}): JSX.Element | null {
  const navigate = useNavigate();
  // 071-M5 H15: 모바일(<768px)은 가운데 Dialog 대신 풀스크린 변형으로 렌더한다.
  const isMobile = useIsMobile();
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

  // 071-M5 H15: 닫기 경로 단일화 — 종전 Dialog onOpenChange 인라인 reset 로직을 그대로
  // 끌어올려 데스크톱 Dialog 와 모바일 풀스크린 닫기 버튼이 공유한다(동작 변경 없음).
  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      reset();
      setIsPublic(false);
      setJoinMode('PRIVATE');
      setEmailDomainsText('');
      setServerError(null);
    }
    onOpenChange(next);
  };

  const formBody = (
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
        {/* 071-M5 H15: slug 는 소문자 식별자 — 모바일 키보드의 자동 대문자/자동 교정이
              검증 실패를 유발하므로 끈다(데스크톱 무영향 표준 속성). */}
        <Input
          id="ws-slug"
          data-testid="ws-slug"
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
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
          {/* S65 fix-forward (a11y BLOCKER-2): switch 의 접근 가능한 이름을 제목
                텍스트에 연결한다(aria-labelledby). 종전 role="switch" 버튼은 텍스트
                자식이 없어 AT 가 "switch" 로만 읽었다. */}
          <div id="ws-visibility-title" className="qf-toggle-row__title">
            공개 여부
          </div>
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
          aria-labelledby="ws-visibility-title"
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
        {/* 071-M5 H15: 도메인 목록도 slug 와 같은 이유로 모바일 자동 대문자/교정을 끈다. */}
        <Input
          id="ws-email-domains"
          data-testid="ws-email-domains"
          type="text"
          placeholder="example.com, corp.io"
          autoCapitalize="none"
          autoCorrect="off"
          // S65 fix-forward (a11y MAJOR-4): 힌트 텍스트를 aria-describedby 로 연결한다.
          aria-describedby="ws-email-domains-hint"
          value={emailDomainsText}
          onChange={(e) => setEmailDomainsText(e.target.value)}
        />
        <p id="ws-email-domains-hint" className="text-[length:var(--fs-12)] text-text-muted">
          콤마 또는 공백으로 구분합니다. 비우면 제한이 없습니다.{' '}
          {/* S65 fix-forward (security MEDIUM = D-3): 화이트리스트 게이트(가입 시 도메인
                검증)는 S66 carryover 라 지금은 저장만 된다. 오해 방지 안내. */}
          <span className="text-text-secondary">도메인 제한은 다음 업데이트에서 적용됩니다.</span>
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
        // S65 fix-forward (a11y BLOCKER-3): 서버 에러는 role="alert" 로 즉시 안내한다.
        <p data-testid="ws-create-error" className="qf-field__error" role="alert">
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
        {/* S65 fix-forward (a11y MAJOR-1): 제출 진행 중 aria-busy 로 상태를 노출한다. */}
        <Button
          data-testid="ws-create-submit"
          type="submit"
          disabled={isPending}
          aria-busy={isPending || undefined}
        >
          {isPending ? '만드는 중…' : '워크스페이스 만들기'}
        </Button>
      </div>
    </form>
  );

  // 071-M5 H15 (audit-rest): 모바일 풀스크린 변형 — PRD 가 참조하는 .qf-m-modal--fullscreen
  // 은 DS 4파일(frozen)에 미정의라 신설하지 않고, 기존 DS 클래스 조합
  // (.qf-m-screen--app + qf-m-topbar + qf-m-body)을 앱 레이어에서 채택해 동일 의도를
  // 구현한다. 진입은 /w/new 라우트(MobileChannelList 레일 '+')라 시트 마커 불요 —
  // 하드웨어 back 은 라우터 히스토리가 처리한다. 데스크톱 Dialog 폼은 불변.
  if (isMobile) {
    if (!open) return null;
    return (
      <div
        data-testid="ws-create-mobile-screen"
        className="fixed inset-0 z-[var(--z-modal,60)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ws-create-mobile-title"
      >
        <div className="qf-m-screen qf-m-screen--app">
          <header className="qf-m-topbar qf-m-safe-top">
            <button
              type="button"
              aria-label="닫기"
              data-testid="ws-create-mobile-close"
              className="qf-m-topbar__back"
              onClick={() => handleOpenChange(false)}
            >
              <Icon name="x" size="md" />
            </button>
            <div className="qf-m-topbar__titleBlock">
              <div id="ws-create-mobile-title" className="qf-m-topbar__title">
                새 워크스페이스
              </div>
              <div className="qf-m-topbar__subtitle">
                이름과 slug를 정하고, 공개 여부는 토글로 선택하세요.
              </div>
            </div>
            <div aria-hidden="true" />
          </header>
          <main className="qf-m-body px-[var(--s-4)] py-[var(--s-3)]">{formBody}</main>
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="새 워크스페이스"
      description="이름과 slug를 정하고, 공개 여부는 토글로 선택하세요."
      className="w-[min(520px,92vw)]"
    >
      {formBody}
    </Dialog>
  );
}
