/**
 * ADR-8 · 공유 상수 단일 정의.
 *
 * 아래 상수는 본 파일에서만 정의됩니다. NFR · D09 · D17 등 모든 도메인은
 * 값을 재정의하지 않고 이 파일의 상수만 import 하여 참조합니다.
 */

/** @everyone 대상 인원 이상 시 UI 확인 모달 (ADR-8). */
export const EVERYONE_CONFIRM_THRESHOLD = 6;

/** 단일 메시지 멘션 합계 이상 시 경고 (ADR-8). */
export const BULK_MENTION_CONFIRM_THRESHOLD = 50;

/** 마우스/키보드 입력 없음 → IDLE 자동 전환 (초). 10분 (ADR-8). */
export const PRESENCE_IDLE_TIMEOUT = 600;

/** 타이핑 Redis 키 TTL (초). 입력 중단 시 자연 소멸 (ADR-8 / FR-P07). */
export const TYPING_TTL = 10;

/**
 * 타이핑 인디케이터 동시 표시 최대 인원 (FR-P07).
 *
 * 서버 typing SET 에 더 많은 사용자가 있어도 와이어로는 최대 이 인원만
 * 싣고, 클라이언트는 "외 N명" 으로 표시한다. 페이로드 비대화 + 멤버
 * 열거를 막는 단일 상한이다.
 */
export const TYPING_MAX_VISIBLE = 3;

/** 시퀀스 홀 갭 복구 시 최대 페이지 수 (ADR-8 / D17). */
export const GAP_FETCH_MAX_PAGES = 10;

/** 미읽 업데이트 분산 락 TTL (ms) (ADR-8 / D09). */
export const UNREAD_LOCK_TTL = 30000;

/** 시퀀스 홀 감지 대기 타임아웃 (ms) — NFR · D17 합의값 (ADR-8). */
export const SEQ_HOLE_TIMEOUT_MS = 500;

/** 클라이언트 메시지 전송 타임아웃 (ms) 기본값. env 로 override (ADR-8 / D17). */
export const MESSAGE_SEND_TIMEOUT_MS_DEFAULT = 5000;

/** GAP_FETCHING 중 pendingEvents 버퍼 상한. 초과 시 truncated=true (D17). */
export const PENDING_EVENTS_MAX = 200;

/** 타이핑 3명 이상 시 typing:batch 일괄 emit 주기 (ms) 기본값 (D17). */
export const TYPING_BATCH_INTERVAL = 2000;

/**
 * 클라이언트 typing:start 재전송 스로틀 (초) (ADR-8 / FR-RT-08 / FR-P07).
 *
 * 첫 키 입력 시 typing:start 를 보낸 뒤, 이 간격 안의 추가 키 입력은 재전송하지
 * 않습니다(불필요한 이벤트 억제). 서버 측 per-(userId, channelId) 스로틀 키
 * (typing:throttle:...) 와 동일 값을 공유해 클라/서버 정책이 일치합니다.
 * 종전 클라이언트는 1.5s 리터럴로 파편화돼 있었으나 PRD 정본(3초)에 맞춰
 * 단일 상수로 모읍니다.
 */
export const TYPING_THROTTLE = 3;

/**
 * 채널당 typing fanout 초당 상한 (FR-RT-08 / D17).
 *
 * 단건 typing:update 브로드캐스트가 한 채널에서 초당 이 횟수를 넘으면 초과분을
 * drop 합니다(batch 타이머가 다음 주기에 full-snapshot 으로 보냅니다). 게이트웨이
 * in-memory sliding-window 로 적용합니다.
 */
export const TYPING_FANOUT_RATE_LIMIT = 10;

/** 마지막 disconnect 후 OFFLINE 전환 grace (초) (D17). */
export const PRESENCE_OFFLINE_GRACE = 35;

/**
 * WS 세션 Redis TTL (초). presence:ping 으로 갱신 (ADR-8).
 *
 * S25 fix-forward(cheap): 종전엔 presence.service 의 `process.env.PRESENCE_SESSION_TTL_SEC
 * ?? 120` 리터럴로 파편화돼 있었습니다. .env.example(PRESENCE_SESSION_TTL_SEC=120)과
 * 정합하도록 기본값을 단일 상수로 모읍니다.
 */
export const PRESENCE_SESSION_TTL_SEC = 120;

/**
 * ONLINE→IDLE 감지 폴링 주기 (ms) (ADR-8 / FR-RT-10).
 *
 * S25 fix-forward(cheap): 게이트웨이 idle sweep 의 `process.env.PRESENCE_IDLE_SWEEP_INTERVAL_MS
 * ?? 30000` 리터럴을 단일 상수로 모읍니다(.env.example=30000 정합).
 */
export const PRESENCE_IDLE_SWEEP_INTERVAL_MS = 30000;

/**
 * presence:subscribe 구독 Set (`presence:sub:{socketId}`) 의 disconnect
 * 후 보존 TTL (초) (FR-P16).
 *
 * 소켓이 끊겨도 구독 Set 을 즉시 삭제하지 않고 이 시간 동안 보존해, grace
 * 창 안에 재연결한 클라이언트가 구독 목록을 다시 보낼 필요 없이 fan-out 을
 * 이어받을 수 있게 한다. 창이 지나면 Redis TTL 이 자연 정리한다. 5분.
 */
export const PRESENCE_SUB_TTL_SEC = 300;

/**
 * 동일 소켓의 presence:subscribe 버스트 상한 (FR-RT-12).
 *
 * 채널 전환 시 구독 목록 재전송이 몰릴 수 있어, 1초 창 안에 이 횟수를 넘는
 * presence:subscribe 는 드롭한다(빈 응답 없이 무시). 게이트웨이 in-memory
 * sliding-window rate-limit.
 */
export const PRESENCE_SUBSCRIBE_BURST_MAX = 10;
export const PRESENCE_SUBSCRIBE_BURST_WINDOW_MS = 1000;

/**
 * S27 (FR-P15): viewport presence 구독 1회 요청 최대 userId 수. 뷰포트에 들어온
 * 멤버/메시지 작성자 id 를 모아 presence:subscribe 로 보내되, 이 값을 넘으면
 * 100개씩 청크로 분할 전송한다(게이트웨이 500-cap 보다 보수적이라 burst-max
 * 압박을 줄이고 한 프레임이 과도하게 커지지 않게 한다).
 */
export const PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK = 100;

/**
 * S27 (FR-P15): 뷰포트 presence 수집 디바운스(ms). IntersectionObserver 콜백이
 * 스크롤 중 연속 발화하므로 이 창 동안 모은 가시 userId 집합을 한 번에 구독한다.
 */
export const PRESENCE_VIEWPORT_DEBOUNCE_MS = 200;

/**
 * presence.updated 브로드캐스트 합치기(coalesce) 창 (ms) (ADR-8).
 *
 * S25 fix-forward(cheap): PresenceThrottler 의 `process.env.PRESENCE_UPDATE_THROTTLE_MS
 * ?? 2000` 리터럴을 단일 상수로 모읍니다(.env.example=2000 정합).
 */
export const PRESENCE_UPDATE_THROTTLE_MS = 2000;

/** Redis 장애 시 발행되는 seq sentinel — hole 감지 skip (D17). */
export const SEQ_SENTINEL = -1;

/**
 * 동시 gap-fetch 채널 수 상한 (FR-RT-23 / D17).
 *
 * 재연결 후 여러 채널이 동시에 GAP_FETCHING 으로 진입하면 REST 폭주가
 * 납니다. 동시에 실제로 gap-fetch 를 수행하는 채널 수를 이 값으로 제한하고,
 * 초과 채널은 FIFO 큐에서 대기하다 슬롯이 비면 순차 실행합니다. 웹 클라이언트는
 * `VITE_GAP_FETCH_CONCURRENCY` 로 override 합니다(기본 5).
 */
export const GAP_FETCH_CONCURRENCY = 5;

/**
 * 사용자당 동시 eager-join 채널 room 상한 (FR-RT-02 / D17).
 *
 * connect 시 RoomManager 가 viewable 채널을 최신 우선으로 정렬해 상위
 * 이 개수만 채널 room 에 join 합니다. user / workspace room 은 상한 대상이
 * 아닙니다. 초과분은 user room 의 unread 이벤트 + REST 로 보완합니다.
 */
export const MAX_JOINED_CHANNELS = 50;

/**
 * ADR-8 상수 전체를 단일 객체로도 노출합니다(분산 락/테스트 등에서 키 순회용).
 */
export const SHARED_CONSTANTS = {
  EVERYONE_CONFIRM_THRESHOLD,
  BULK_MENTION_CONFIRM_THRESHOLD,
  PRESENCE_IDLE_TIMEOUT,
  TYPING_TTL,
  TYPING_MAX_VISIBLE,
  GAP_FETCH_MAX_PAGES,
  UNREAD_LOCK_TTL,
  SEQ_HOLE_TIMEOUT_MS,
  MESSAGE_SEND_TIMEOUT_MS_DEFAULT,
  PENDING_EVENTS_MAX,
  TYPING_BATCH_INTERVAL,
  // S32 (FR-RT-08): 클라 typing:start 스로틀 + 채널 fanout 초당 상한.
  TYPING_THROTTLE,
  TYPING_FANOUT_RATE_LIMIT,
  PRESENCE_OFFLINE_GRACE,
  // S25 fix-forward(cheap): presence env 기본값을 단일 상수로 모아 파편화 해소.
  PRESENCE_SESSION_TTL_SEC,
  PRESENCE_IDLE_SWEEP_INTERVAL_MS,
  PRESENCE_UPDATE_THROTTLE_MS,
  // S26 (FR-P16 / FR-RT-12): 구독 lifecycle TTL + subscribe 버스트 상한.
  PRESENCE_SUB_TTL_SEC,
  PRESENCE_SUBSCRIBE_BURST_MAX,
  PRESENCE_SUBSCRIBE_BURST_WINDOW_MS,
  // S27 (FR-P15): viewport 구독 청크/디바운스.
  PRESENCE_VIEWPORT_SUBSCRIBE_CHUNK,
  PRESENCE_VIEWPORT_DEBOUNCE_MS,
  SEQ_SENTINEL,
  GAP_FETCH_CONCURRENCY,
  // S10 fix-forward (FIX #6): S07 에서 추가된 상수가 단일 객체 노출에서 누락돼
  // 있었습니다. 키 순회/테스트 경로가 이 객체만 보므로 함께 노출합니다.
  MAX_JOINED_CHANNELS,
} as const;
