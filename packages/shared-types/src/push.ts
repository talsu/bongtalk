import { z } from 'zod';

/**
 * S86 (FR-MN-15): Web Push(VAPID) 컨트랙트 — 서버(apps/api)와 클라이언트(apps/web)가
 * 공유하는 단일 출처다. class-validator DTO 대신 컨트롤러에서 safeParse 로 검증하는
 * 기존 settings 패턴(security/privacy)을 따른다.
 *
 *   GET    /api/v1/push/vapid-public-key      → VapidPublicKeyResponse(JwtAuthGuard·비밀 아님)
 *   POST   /api/v1/me/push/subscriptions      PushSubscriptionRequest(upsert by endpoint)
 *   DELETE /api/v1/me/push/subscriptions      PushUnsubscribeRequest(by endpoint)
 *
 * PushSubscriptionRequest 는 브라우저 PushManager.subscribe() 가 돌려주는
 * PushSubscriptionJSON 의 부분집합이다(endpoint + keys{p256dh,auth}). expirationTime
 * 등 부가 필드는 서버가 쓰지 않으므로 받지 않는다(엄격 검증 — 알 수 없는 키는 무시).
 */

/** push endpoint URL 상한 — 브라우저 push service URL 은 길지만 비정상적으로 긴 값은 거부. */
export const PUSH_ENDPOINT_MAX = 2048;
/** p256dh / auth base64url 키 상한(여유 포함). */
export const PUSH_KEY_MAX = 256;

/**
 * S86 리뷰 fix-forward (security MAJOR = SSRF): 구독 endpoint 는 web-push 가 서버측에서
 * POST 하는 URL 이라, 임의 URL 을 받으면 인증된 사용자가 NAS 내부망(Redis/PG/MinIO/배포
 * 웹훅)으로 서버를 시켜 요청을 던지는 SSRF 표면이 된다. 실제 브라우저 push service 는
 * 알려진 소수 호스트뿐이므로 https + 호스트 allowlist 로 제한한다. 라벨 경계(.) 접두로
 * `evil-fcm.googleapis.com` 류를 막고, 비-https/내부망/임의 호스트는 전부 거부한다.
 */
const ALLOWED_PUSH_HOSTS: readonly string[] = [
  'fcm.googleapis.com', // Chrome / Android (FCM)
  'android.googleapis.com', // legacy GCM
  'updates.push.services.mozilla.com', // Firefox (autopush)
];
const ALLOWED_PUSH_HOST_SUFFIXES: readonly string[] = [
  '.push.services.mozilla.com', // Firefox autopush (지역 서브도메인)
  '.notify.windows.com', // Edge / WNS
  '.wns.windows.com', // WNS
  '.push.apple.com', // Safari (APNs web push)
];

/** endpoint 가 https + 알려진 push service 호스트인지(SSRF allowlist). */
export function isAllowedPushEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (ALLOWED_PUSH_HOSTS.includes(host)) return true;
  return ALLOWED_PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

const PushEndpointSchema = z
  .string()
  .url()
  .max(PUSH_ENDPOINT_MAX)
  .refine(isAllowedPushEndpoint, { message: 'endpoint must be a known https push service' });

export const PushSubscriptionKeysSchema = z.object({
  // ECDH 공개키(base64url). 길이 검증은 BE 가 web-push 에 위임(형식 단언은 비어있지 않음만).
  p256dh: z.string().min(1).max(PUSH_KEY_MAX),
  // 인증 시크릿(base64url).
  auth: z.string().min(1).max(PUSH_KEY_MAX),
});
export type PushSubscriptionKeys = z.infer<typeof PushSubscriptionKeysSchema>;

export const PushSubscriptionRequestSchema = z.object({
  endpoint: PushEndpointSchema,
  keys: PushSubscriptionKeysSchema,
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequestSchema>;

export const PushUnsubscribeRequestSchema = z.object({
  // 해제는 endpoint 를 삭제 키로만 쓰고 서버가 fetch 하지 않지만, 등록과 동일 allowlist 를
  // 적용해 일관성을 유지한다(저장된 구독은 이미 allowlist 통과분이라 정상 해제에 무영향).
  endpoint: PushEndpointSchema,
});
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequestSchema>;

export const VapidPublicKeyResponseSchema = z.object({
  // VAPID application server 공개키(base64url). 비어있으면(키 미설정) 클라가 구독을 시도하지 않는다.
  publicKey: z.string(),
});
export type VapidPublicKeyResponse = z.infer<typeof VapidPublicKeyResponseSchema>;

/**
 * S86 (FR-MN-15): 푸시 알림 페이로드(서버 → SW). showNotification 에 매핑되는 최소 형태.
 * SW(push 이벤트)가 이 JSON 을 파싱해 title/body/icon/data.url 로 알림을 띄운다. url 은
 * notificationclick 에서 focus/openWindow 할 딥링크다(채널/메시지 경로).
 */
export interface PushNotificationPayload {
  title: string;
  body: string;
  /** 알림 아이콘 URL(없으면 SW 기본값). */
  icon?: string;
  /** 클릭 시 이동할 앱 내 경로(예: /w/{wsId}/c/{channelId}). */
  url?: string;
  /** 동일 컨텍스트 알림 묶음 태그(같은 채널 멘션은 교체). */
  tag?: string;
}
