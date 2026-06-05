import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ACCESSIBILITY } from '@qufox/shared-types';
import { useNotifications } from '../../stores/notification-store';
import {
  useAccessibilitySettings,
  useUpdateAccessibilitySettings,
} from './useAccessibilitySettings';

/**
 * S77a (D14 / FR-PS-12 + FR-PS-18): 설정 > 접근성 탭(자동 저장).
 *
 * 모션 줄이기(reduceMotion) · 고대비(highContrast) 두 토글을 한 화면에서 편집한다. 모든
 * 컨트롤은 onChange 즉시 PATCH 자동 저장하며(낙관적 갱신 → 실패 시 revert + 토스트), 저장
 * 성공 시 aria-live 영역으로 "저장됨" 을 통지한다(S76 F-H4 선례).
 *
 * S76 a11y 교훈: 토글은 role=switch + aria-checked 단일 컨트롤이라 radio 이중 aria-label
 * 문제가 없다. reduceMotion 은 app CSS(index.css)의 html[data-reduce-motion="true"] 규칙으로
 * 실제 동작한다(죽은 컨트롤 아님). highContrast 는 DS 고대비 테마 부재로 app CSS 의 최소
 * 보정만 적용한다(carryover — DS-owner 가 고대비 토큰 추가 시 강화).
 */
export function AccessibilitySettingsPage(): JSX.Element {
  const { data } = useAccessibilitySettings();
  const update = useUpdateAccessibilitySettings();
  const notify = useNotifications((s) => s.push);

  const settings = data ?? DEFAULT_ACCESSIBILITY;

  // 자동저장 성공 시 SR 에 "저장됨" 을 통지하는 라이브 영역(S76 F-H4 선례).
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

  const onReduceMotion = (reduceMotion: boolean): void =>
    save({ reduceMotion }, '모션 설정 저장 실패');
  const onHighContrast = (highContrast: boolean): void =>
    save({ highContrast }, '고대비 설정 저장 실패');

  return (
    <div data-testid="accessibility-settings-page">
      <h1 className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
        접근성
      </h1>
      <p className="mb-[var(--s-6)] mt-[var(--s-1)] text-[length:var(--fs-13)] text-text-muted">
        화면 표시 방식을 바꾸면 즉시 저장되고 모든 기기에 반영됩니다.
      </p>

      {/* 모션 줄이기 */}
      <section aria-labelledby="a11y-motion-heading" data-testid="a11y-reduce-motion">
        <h2 id="a11y-motion-heading" className="sr-only">
          모션 줄이기
        </h2>
        <div className="qf-toggle-row">
          <div className="qf-toggle-row__text">
            <div className="qf-toggle-row__title">모션 줄이기</div>
            <div className="qf-toggle-row__desc">
              애니메이션과 자동 재생, 부드러운 스크롤을 줄여 어지러움을 완화합니다. 운영체제에서
              모션 줄이기를 켜 두었다면 기본으로 반영됩니다.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.reduceMotion}
            aria-label="모션 줄이기"
            disabled={update.isPending}
            data-testid="a11y-reduce-motion-toggle"
            className="qf-switch"
            onClick={() => onReduceMotion(!settings.reduceMotion)}
          />
        </div>
      </section>

      {/* 고대비 */}
      <section aria-labelledby="a11y-contrast-heading" data-testid="a11y-high-contrast">
        <h2 id="a11y-contrast-heading" className="sr-only">
          고대비
        </h2>
        <div className="qf-toggle-row">
          <div className="qf-toggle-row__text">
            <div className="qf-toggle-row__title">고대비</div>
            <div className="qf-toggle-row__desc">
              테두리와 포커스 표시를 또렷하게 보강해 가독성을 높입니다.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.highContrast}
            aria-label="고대비"
            disabled={update.isPending}
            data-testid="a11y-high-contrast-toggle"
            className="qf-switch"
            onClick={() => onHighContrast(!settings.highContrast)}
          />
        </div>
      </section>

      {/* 자동저장 상태 라이브 영역(S76 F-H4 선례 — 시각적으로는 sr-only). */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="a11y-save-status"
        className="sr-only"
      >
        {savedAt !== null ? '저장됨' : ''}
      </p>
    </div>
  );
}
