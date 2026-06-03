import { AttachmentTrayCard } from './AttachmentTrayCard';
import type { TrayItem } from './useAttachmentUpload';

/**
 * S56 (D11 / FR-AM-02/22) — 전송 전 첨부 미리보기 트레이(컴포저 위 가로 스크롤).
 * 항목이 없으면 렌더하지 않습니다.
 */
export function AttachmentTray({
  items,
  onRemove,
  onRetry,
  onAltChange,
  onToggleSpoiler,
}: {
  items: TrayItem[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onAltChange: (id: string, alt: string) => void;
  onToggleSpoiler: (id: string) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul data-testid="attachment-tray" className="mb-[var(--s-2)] flex flex-wrap gap-[var(--s-2)]">
      {items.map((item) => (
        <AttachmentTrayCard
          key={item.id}
          item={item}
          onRemove={onRemove}
          onRetry={onRetry}
          onAltChange={onAltChange}
          onToggleSpoiler={onToggleSpoiler}
        />
      ))}
    </ul>
  );
}
