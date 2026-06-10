import { memo } from 'react';
import { formatDayDivider, localDayKey } from './formatMessageTime';

/**
 * S06 (FR-MSG-11) — 채널 날짜 구분선. DS 4 파일에는 채널용 day-divider 전용
 * 클래스가 없고(`.qf-thread-divider` 는 thread 패널 전용) 이므로, DS 토큰
 * (--divider / --fs-11 / --s-4)을 Tailwind arbitrary 로만 사용해 구성합니다
 * (raw hex/px 금지). 가운데 라벨('YYYY년 MM월 DD일') + 양옆 1px 선.
 *
 * 071-M1 D1: MessageList 내부 leaf 였으나 모바일(MobileMessages)도 동일 구분선을
 * 쓰므로 모듈로 추출 — 마크업/토큰 동일, 양 표면 공유.
 *
 * S101 (perf carryover · LOW): 단일 원시 prop(iso)만 받는 순수 leaf — iso 가
 * 바뀌지 않으면 memo 가 내부 재렌더를 건너뛴다.
 */
export const DayDivider = memo(function DayDivider({ iso }: { iso: string }): JSX.Element {
  return (
    <div
      role="separator"
      // a11y(S06 review): separator 가 텍스트 자식을 건너뛰어도 날짜 전환을
      // 읽도록 컨테이너에 aria-label, 라벨은 기계 판독 가능한 <time> 으로.
      aria-label={formatDayDivider(iso)}
      data-testid={`day-divider-${localDayKey(iso)}`}
      className="flex items-center gap-[var(--s-3)] px-[var(--s-7)] py-[var(--s-4)]"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--divider)]" />
      <time
        dateTime={localDayKey(iso)}
        className="text-[length:var(--fs-11)] font-medium text-text-muted"
      >
        {formatDayDivider(iso)}
      </time>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--divider)]" />
    </div>
  );
});
