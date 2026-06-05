import { useEffect, useRef, useState } from 'react';
import {
  CHAT_FONT_SIZES,
  DEFAULT_APPEARANCE,
  type Density,
  type Theme,
  type ChatFontSize,
} from '@qufox/shared-types';
import { useNotifications } from '../../stores/notification-store';
import { useAppearanceSettings, useUpdateAppearanceSettings } from './useAppearanceSettings';

/**
 * S76 (D14 / FR-PS-09 + FR-PS-18): 설정 > 외관 탭(자동 저장).
 *
 * 테마(DARK/LIGHT/SYSTEM) · 메시지 밀도(COZY/COMPACT) · 채팅 폰트 크기(6단계) ·
 * 24시간 시계 토글을 한 화면에서 편집한다. 모든 컨트롤은 onChange 즉시 PATCH 자동
 * 저장하며(Fork B1, 낙관적 갱신 → 실패 시 revert + 토스트), 폰트 슬라이더만 연속
 * 드래그 중 과한 왕복을 막으려 200ms debounce 한다.
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

const FONT_DEBOUNCE_MS = 200;

export function AppearanceSettingsPage(): JSX.Element {
  const { data } = useAppearanceSettings();
  const update = useUpdateAppearanceSettings();
  const notify = useNotifications((s) => s.push);

  const settings = data ?? DEFAULT_APPEARANCE;

  // 폰트 슬라이더 로컬 값(드래그 중 즉시 반응) + debounce 타이머.
  const [fontDraft, setFontDraft] = useState<ChatFontSize>(settings.chatFontSize);
  const fontTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setFontDraft(settings.chatFontSize);
  }, [settings.chatFontSize]);
  useEffect(
    () => () => {
      if (fontTimer.current) clearTimeout(fontTimer.current);
    },
    [],
  );

  const save = (patch: Parameters<typeof update.mutateAsync>[0], failTitle: string): void => {
    void update.mutateAsync(patch).catch((err: unknown) => {
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

  // 슬라이더: index(0~5) → 6단계 px. 드래그 중 로컬 즉시 반영, 200ms 후 1회 PATCH.
  const onFontIndex = (index: number): void => {
    const next = CHAT_FONT_SIZES[index] ?? DEFAULT_APPEARANCE.chatFontSize;
    setFontDraft(next);
    if (fontTimer.current) clearTimeout(fontTimer.current);
    fontTimer.current = setTimeout(() => {
      save({ chatFontSize: next }, '폰트 크기 저장 실패');
    }, FONT_DEBOUNCE_MS);
  };

  const fontIndex = Math.max(0, CHAT_FONT_SIZES.indexOf(fontDraft));

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
              <input
                aria-label={opt.label}
                type="radio"
                name="appearance-theme"
                value={opt.value}
                checked={opt.value === settings.theme}
                disabled={update.isPending}
                onChange={() => onTheme(opt.value)}
                data-testid={`appearance-theme-${opt.value}`}
                className="mt-[var(--s-1)]"
              />
              <span className="flex flex-col">
                <span className="text-[length:var(--fs-14)] font-medium text-foreground">
                  {opt.label}
                </span>
                <span className="text-[length:var(--fs-12)] text-text-muted">{opt.hint}</span>
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
              <input
                aria-label={opt.label}
                type="radio"
                name="appearance-density"
                value={opt.value}
                checked={opt.value === settings.density}
                disabled={update.isPending}
                onChange={() => onDensity(opt.value)}
                data-testid={`appearance-density-${opt.value}`}
                className="mt-[var(--s-1)]"
              />
              <span className="flex flex-col">
                <span className="text-[length:var(--fs-14)] font-medium text-foreground">
                  {opt.label}
                </span>
                <span className="text-[length:var(--fs-12)] text-text-muted">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* 채팅 폰트 크기 (슬라이더 · 200ms debounce) */}
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
        <p className="mb-[var(--s-3)] text-[length:var(--fs-12)] text-text-muted">
          현재 {fontDraft}px
        </p>
        <input
          aria-label="채팅 폰트 크기"
          aria-valuetext={`${fontDraft}px`}
          type="range"
          min={0}
          max={CHAT_FONT_SIZES.length - 1}
          step={1}
          value={fontIndex}
          disabled={update.isPending}
          onChange={(e) => onFontIndex(Number(e.target.value))}
          data-testid="appearance-font-slider"
          className="w-full max-w-[var(--w-settings,360px)] accent-[color:var(--accent)]"
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
    </div>
  );
}
