import { SEQ_SENTINEL } from '@qufox/shared-types';

/**
 * S10 (FR-RT-06 / FR-RT-07): 채널별 seq 추적 + hole(갭) 감지 — 순수 로직.
 *
 * 서버는 채널 스코프 실시간 이벤트마다 `Redis INCR seq:{channelId}` 로 만든
 * 단조 증가 seq 를 페이로드에 싣습니다. 클라이언트는 채널별로 마지막으로 본
 * seq 를 보관하고, 새 이벤트의 seq 가 직전 값 + 1 이 아니면 "hole(누락)" 으로
 * 판정해 gap-fetch FSM 을 깨웁니다.
 *
 * seq 는 **갭 감지 힌트 전용**입니다. 메시지 렌더 정렬은 여전히 id(cuid2/uuid)
 * 기준이며 seq 로 정렬하지 않습니다(서버 FR-RT-06 합의).
 *
 * SEQ_SENTINEL(-1): Redis 장애로 서버가 seq 를 채우지 못한 경우의 표식입니다.
 * sentinel 수신 시에는 hole 판정을 건너뛰어(=불연속으로 보지 않음) 루프성
 * gap-fetch 를 막습니다. 단조성 추적도 갱신하지 않습니다(다음 정상 seq 와
 * 비교가 어긋나지 않도록).
 *
 * React 의존이 없어 훅과 단위 테스트가 동일 함수를 공유합니다.
 */

/** 단일 이벤트 observe 결과. */
export type SeqObservation =
  /** 첫 이벤트(기준선 수립)이거나 직전 seq + 1 로 연속. */
  | { kind: 'ok' }
  /** seq 가 직전 +1 이 아님 → 누락 구간 존재(gap-fetch 필요). */
  | { kind: 'hole'; expected: number; got: number }
  /** SEQ_SENTINEL(-1) — Redis 장애. hole 판정/단조성 갱신 모두 skip. */
  | { kind: 'sentinel' }
  /** 직전에 이미 본 seq(중복/at-least-once 재전송) — 무시. */
  | { kind: 'duplicate' };

export class SeqTracker {
  /** channelId → 마지막으로 본 (정상) seq. */
  private readonly lastSeq = new Map<string, number>();

  /**
   * 한 채널 이벤트의 seq 를 관찰해 hole 여부를 판정하고, 정상이면 단조성 추적을
   * 전진시킵니다. 호출자는 결과 kind 로 FSM 전이를 결정합니다.
   */
  observe(channelId: string, seq: number): SeqObservation {
    if (seq === SEQ_SENTINEL) return { kind: 'sentinel' };
    const prev = this.lastSeq.get(channelId);
    if (prev === undefined) {
      // 기준선 수립 — 첫 관측은 hole 로 보지 않습니다.
      this.lastSeq.set(channelId, seq);
      return { kind: 'ok' };
    }
    if (seq <= prev) {
      // 재전송/순서 뒤집힘 — 단조성은 유지(전진하지 않음).
      return { kind: 'duplicate' };
    }
    if (seq === prev + 1) {
      this.lastSeq.set(channelId, seq);
      return { kind: 'ok' };
    }
    // prev + 1 < seq → 사이에 누락. 추적값은 새 seq 로 전진(같은 hole 을
    // 매 이벤트마다 다시 트리거하지 않도록) 시키되, 호출자에게 hole 을 알립니다.
    const expected = prev + 1;
    this.lastSeq.set(channelId, seq);
    return { kind: 'hole', expected, got: seq };
  }

  /** join 스냅샷 등으로 받은 채널 seq 기준선을 설정합니다. */
  setBaseline(channelId: string, seq: number): void {
    if (seq === SEQ_SENTINEL) return;
    this.lastSeq.set(channelId, seq);
  }

  /** 채널의 마지막 seq(미관측이면 undefined). */
  get(channelId: string): number | undefined {
    return this.lastSeq.get(channelId);
  }

  /** 현재 추적 중인(=한 번이라도 관측한) 채널 id 목록. */
  channels(): string[] {
    return [...this.lastSeq.keys()];
  }

  /** 채널 추적 상태 제거(LRU evict / 채널 떠남 시). */
  reset(channelId: string): void {
    this.lastSeq.delete(channelId);
  }

  /** 전체 초기화(로그아웃 / 소켓 교체). */
  clear(): void {
    this.lastSeq.clear();
  }
}
