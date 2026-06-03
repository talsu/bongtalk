import { Icon } from '../../design-system/primitives';

/**
 * S56 (D11 / FR-AM-01/21) — 드래그 오버 시 채팅 컬럼 위에 뜨는 업로드 안내
 * 오버레이. DS `qf-upload-overlay`(+__icon/__title/__hint) 만 사용합니다.
 * absolute · pointer-events:none(DS 정의) 이라 드롭 이벤트는 아래 래퍼가 받습니다.
 * 래퍼는 position:relative 여야 합니다(MessageColumn 이 보장).
 */
export function DropZoneOverlay({ channelName }: { channelName: string }): JSX.Element {
  return (
    <div data-testid="dropzone-overlay" className="qf-upload-overlay" aria-hidden="true">
      <div className="qf-upload-overlay__icon">
        <Icon name="upload" size="xl" />
      </div>
      <div className="qf-upload-overlay__title">여기에 파일을 놓아 업로드</div>
      <div className="qf-upload-overlay__hint">{`#${channelName} 에 첨부됩니다`}</div>
    </div>
  );
}
