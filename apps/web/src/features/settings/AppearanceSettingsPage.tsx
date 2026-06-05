import { useEffect, useRef, useState } from 'react';
import { CHAT_FONT_SIZES, DEFAULT_APPEARANCE, type Density, type Theme } from '@qufox/shared-types';
import { useNotifications } from '../../stores/notification-store';
import { useAppearanceSettings, useUpdateAppearanceSettings } from './useAppearanceSettings';

/**
 * S76 (D14 / FR-PS-09 + FR-PS-18): 설정 > 외관 탭(자동 저장).
 *
 * 테마(DARK/LIGHT/SYSTEM) · 메시지 밀도(COZY/COMPACT) · 24시간 시계 토글을 한 화면에서
 * 편집한다. 모든 컨트롤은 onChange 즉시 PATCH 자동 저장하며(Fork B1, 낙관적 갱신 → 실패 시
 * revert + 토스트), 저장 성공 시 aria-live 영역으로 "저장됨" 을 통지한다(F-H4).
 *
 * F-M1: 채팅 폰트 크기 슬라이더는 DS 4파일에 `--fs-chat` 참조 규칙이 0건이라 시각 효과가
 * 없고 raw px 주입은 1.4.4 위반이므로 **비활성화**(준비 중)한다. 값은 저장/조회는 계속
 * 유지하되 시각 적용은 DS-owner 가 qf-message__body 배선을 추가하는 carryover 다.
 */

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; hint: string }> = [
  { value: 'DARK', label: '다크', hint: '어두운 배경(기본).' },
  { value: 'LIGHT', label: '라이트', hint: '밝은 배경.' },
  { value: 'SYSTEM', label: '시스템', hint: '운영체제 설정을 따릅니다.' },
];

const DENSITY_OPTIONS: ReadonlyArray<{ value: Density; label: string; hint: string }> = [
  { value: 'COZY', label: '편안하게', hint: '여백이 넉넉한 기본 보기.' },
  { value: 'COMPACT', label: '빽빽하게', hint: '한 화면에 더 많은 메시지를 표시합니다.' },
];

export function AppearanceSettingsPage(): JSX.Element {
  const { data } = useAppearanceSettings();
  const update = useUpdateAppearanceSettings();
  const notify = useNotifications((s) => s.push);

  const settings = data ?? DEFAULT_APPEARANCE;

  // F-H4 (a11y HIGH-04): 자동저장 성공 시 SR 에 "저장됨" 을 통지하는 라이브 영역 메시지.
  // DndSnoozeControl 선례를 따라 aria-live=polite + aria-atomic 영역에 갱신한다.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );
  const announceSaved = (): void => {
    setSavedAt(Date.now());
    if (savedTimer.current) clearTimeout(savedTimer.current);
    // 잠시 후 메시지를 비워 다음 저장의 동일 텍스트도 다시 announce 되게 한다.
    savedTimer.current = setTimeout(() => setSavedAt(null), 3000);
  };

  const save = (patch: Parameters<typeof update.mutateAsync>[0], failTitle: string): void => {
    void update
      .mutateAsync(patch)
      .then(() => announceSaved())
      .catch((err: unknown) => {
        notify({
          variant: 'danger',
          title: failTitle,
          body: err instanceof Error ? err.message : '잠시 후 다시 시도해 주세요.',
        });
      });
  };

  const onTheme = (theme: Theme): void => save({ theme }, '테마 저장 실패');
  const onDensity = (density: Density): void => save({ density }, '밀도 저장 실패');
  const onClock = (clock24h: boolean): void => save({ clock24h }, '시계 형식 저장 실패');

  // F-M1: 슬라이더는 비활성(준비 중)이라 현재 저장된 폰트 값만 표시한다.
  const fontIndex = Math.max(0, CHAT_FONT_SIZES.indexOf(settings.chatFontSize));

  return (
    <div data-testid="appearance-settings-page">
      <h1 className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
        외관
      </h1>
      <p className="mb-[var(--s-6)] mt-[var(--s-1)] text-[length:var(--fs-13)] text-text-muted">
        테마와 메시지 표시 방식을 바꾸면 즉시 저장되고 모든 기기에 반영됩니다.
      </p>

      {/* 테마 */}
      <section
        className="mb-[var(--s-6)]"
        aria-labelledby="appearance-theme-heading"
        data-testid="appearance-theme"
      >
        <h2
          id="appearance-theme-heading"
          className="mb-[var(--s-3)] text-[length:var(--fs-16)] font-semibold text-text-strong"
        >
          테마
        </h2>
        <div role="radiogroup" aria-label="테마" className="flex flex-col gap-[var(--s-2)]">
          {THEME_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-[var(--s-3)] rounded-[var(--r-md)] border border-border-subtle p-[var(--s-3)] data-[active=true]:border-[color:var(--accent)] data-[active=true]:bg-[color:var(--accent-subtle)]"
              data-active={opt.value === settings.theme}
            >
              {/* F-J1 (a11y MAJ-01): 명시 aria-label(opt.label 단독) 대신 aria-labelledby 로
                  라벨 + hint span 을 함께 접근명으로 묶는다(hint 누락 방지 — aria-label 은 hint 를
                  가린다). 래퍼 <label> 텍스트도 동일 텍스트라 정합한다. */}
              <input
                type="radio"
                aria-labelledby={`appearance-theme-${opt.value}-label appearance-theme-${opt.value}-hint`}
                name="appearance-theme"
                value={opt.value}
                checked={opt.value === settings.theme}
                disabled={update.isPending}
                onChange={() => onTheme(opt.value)}
                data-testid={`appearance-theme-${opt.value}`}
                className="mt-[var(--s-1)]"
              />
              <span className="flex flex-col">
                <span
                  id={`appearance-theme-${opt.value}-label`}
                  className="text-[length:var(--fs-14)] font-medium text-foreground"
                >
                  {opt.label}
                </span>
                <span
                  id={`appearance-theme-${opt.value}-hint`}
                  className="text-[length:var(--fs-12)] text-text-muted"
                >
                  {opt.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* 메시지 밀도 */}
      <section
        className="mb-[var(--s-6)]"
        aria-labelledby="appearance-density-heading"
        data-testid="appearance-density"
      >
        <h2
          id="appearance-density-heading"
          className="mb-[var(--s-3)] text-[length:var(--fs-16)] font-semibold text-text-strong"
        >
          메시지 밀도
        </h2>
        <div role="radiogroup" aria-label="메시지 밀도" className="flex flex-col gap-[var(--s-2)]">
          {DENSITY_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-[var(--s-3)] rounded-[var(--r-md)] border border-border-subtle p-[var(--s-3)] data-[active=true]:border-[color:var(--accent)] data-[active=true]:bg-[color:var(--accent-subtle)]"
              data-active={opt.value === settings.density}
            >
              {/* F-J1 (a11y MAJ-01): aria-labelledby 로 라벨 + hint 를 접근명으로 묶는다. */}
              <input
                type="radio"
                aria-labelledby={`appearance-density-${opt.value}-label appearance-density-${opt.value}-hint`}
                name="appearance-density"
                value={opt.value}
                checked={opt.value === settings.density}
                disabled={update.isPending}
                onChange={() => onDensity(opt.value)}
                data-testid={`appearance-density-${opt.value}`}
                className="mt-[var(--s-1)]"
              />
              <span className="flex flex-col">
                <span
                  id={`appearance-density-${opt.value}-label`}
                  className="text-[length:var(--fs-14)] font-medium text-foreground"
                >
                  {opt.label}
                </span>
                <span
                  id={`appearance-density-${opt.value}-hint`}
                  className="text-[length:var(--fs-12)] text-text-muted"
                >
                  {opt.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* 채팅 폰트 크기 (F-M1: 비활성 — 준비 중. DS-owner 가 --fs-chat 배선 후 활성화) */}
      <section
        className="mb-[var(--s-6)]"
        aria-labelledby="appearance-font-heading"
        data-testid="appearance-font"
      >
        <h2
          id="appearance-font-heading"
          className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
        >
          채팅 폰트 크기
        </h2>
        <p
          id="appearance-font-hint"
          data-testid="appearance-font-hint"
          className="mb-[var(--s-3)] text-[length:var(--fs-12)] text-text-muted"
        >
          준비 중 — 디자인 시스템 지원 후 활성화됩니다. (현재 {settings.chatFontSize}px)
        </p>
        {/* F-M1 (a11y 1.4.4 · ui MAJOR): 슬라이더 비활성화. raw px `--fs-chat` 주입을
            제거했으므로(applyAppearanceToDOM) 시각 효과가 없는 죽은 컨트롤을 막는다.
            aria-disabled + describedby 로 비활성 사유를 보조기술에 전달한다. */}
        <input
          aria-label="채팅 폰트 크기"
          aria-valuetext={`${settings.chatFontSize}px`}
          aria-disabled="true"
          aria-describedby="appearance-font-hint"
          type="range"
          min={0}
          max={CHAT_FONT_SIZES.length - 1}
          step={1}
          value={fontIndex}
          disabled
          readOnly
          data-testid="appearance-font-slider"
          className="w-full max-w-[var(--w-settings)] accent-[color:var(--accent)] opacity-50"
        />
        <div className="mt-[var(--s-1)] flex justify-between text-[length:var(--fs-11)] text-text-muted">
          {CHAT_FONT_SIZES.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      </section>

      {/* 24시간 시계 */}
      <section aria-labelledby="appearance-clock-heading" data-testid="appearance-clock">
        <h2 id="appearance-clock-heading" className="sr-only">
          시계 형식
        </h2>
        <div className="qf-toggle-row">
          <div className="qf-toggle-row__text">
            <div className="qf-toggle-row__title">24시간 시계</div>
            <div className="qf-toggle-row__desc">
              메시지 시각을 24시간제(예: 14:30)로 표시합니다.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.clock24h}
            aria-label="24시간 시계"
            disabled={update.isPending}
            data-testid="appearance-clock-toggle"
            className="qf-switch"
            onClick={() => onClock(!settings.clock24h)}
          />
        </div>
      </section>

      {/* F-H4 (a11y HIGH-04): 자동저장 상태 라이브 영역. 저장 성공 시 "저장됨" 을 SR 에
          통지한다(DndSnoozeControl 선례). 시각적으로는 sr-only — 자동저장이 즉시라 별도
          시각 배지는 두지 않는다. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="appearance-save-status"
        className="sr-only"
      >
        {savedAt !== null ? '저장됨' : ''}
      </p>
    </div>
  );
}
