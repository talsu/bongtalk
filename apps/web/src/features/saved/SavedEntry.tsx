import { useState } from 'react';
import { Icon, SettingsOverlay } from '../../design-system/primitives';
import { useSavedCount } from './useSavedMessages';
import { SavedView } from './SavedView';

/**
 * S51 (D10 / FR-PS-07): 사이드바 "저장됨" 진입점 + IN_PROGRESS 카운트 배지.
 * 클릭 시 SavedView(3탭)를 오버레이로 연다(ThreadsView/ChannelBrowser 와 동일한
 * 사이드바 고정 항목 패턴 — 신규 라우트 없이 기존 SettingsOverlay 재사용). DS 기존
 * 클래스(qf-channel / qf-badge)만 사용하며 raw hex/px 없음.
 */
export function SavedEntry(): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data } = useSavedCount();
  const count = data?.count ?? 0;

  return (
    <>
      <button
        type="button"
        data-testid="saved-entry"
        onClick={() => setOpen(true)}
        className="qf-channel group relative w-full text-left"
      >
        <span className="qf-channel__prefix pointer-events-none relative">
          <Icon name="bookmark" size="sm" />
        </span>
        <span className="flex-1">저장됨</span>
        {count > 0 ? (
          <span className="qf-badge qf-badge--count" data-testid="saved-entry-badge">
            {count}
          </span>
        ) : null}
      </button>
      <SettingsOverlay
        open={open}
        onClose={() => setOpen(false)}
        title="저장됨"
        testId="saved-overlay"
      >
        <SavedView />
      </SettingsOverlay>
    </>
  );
}
