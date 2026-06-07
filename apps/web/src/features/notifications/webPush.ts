import { apiRequest } from '../../lib/api';
import {
  VapidPublicKeyResponseSchema,
  type PushSubscriptionRequest,
  type VapidPublicKeyResponse,
} from '@qufox/shared-types';

/**
 * S86 (FR-MN-15): Web Push 구독 헬퍼 + 순수 권한 판정.
 *
 * 브라우저 API(Notification / navigator.serviceWorker / PushManager)는 테스트가 어려우므로,
 * 권한 상태 판정(pure)과 부수효과(register/subscribe/fetch)를 분리한다. 권한 요청은 사용자
 * 클릭에서만 호출한다(첫 진입 자동 요청 금지 — PRD).
 */

export type PushPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/**
 * 현재 브라우저의 알림 권한 상태를 순수 판정한다(부수효과 없음). Notification API 미지원이면
 * 'unsupported'. 그 외는 Notification.permission 을 그대로 매핑한다. 테스트에서 nav/perm 을
 * 주입할 수 있도록 인자로 받는다(기본은 globalThis).
 */
export function resolvePushPermission(
  win: {
    Notification?: { permission: NotificationPermission };
    navigator?: { serviceWorker?: unknown };
    PushManager?: unknown;
  } = globalThis as never,
): PushPermissionState {
  const hasNotification = typeof win.Notification !== 'undefined';
  const hasSW = !!win.navigator?.serviceWorker;
  const hasPush = typeof win.PushManager !== 'undefined';
  if (!hasNotification || !hasSW || !hasPush) return 'unsupported';
  const perm = win.Notification!.permission;
  if (perm === 'granted') return 'granted';
  if (perm === 'denied') return 'denied';
  return 'default';
}

/**
 * base64url VAPID 공개키를 PushManager.subscribe 가 요구하는 Uint8Array 로 변환한다(표준
 * 변환 — web-push 문서 정본). padding 보정 + URL-safe → 표준 base64 치환 후 atob.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** 서버에서 VAPID 공개키를 받아온다(구독 직전 fetch — 단일 출처 .env.prod). */
export async function fetchVapidPublicKey(): Promise<VapidPublicKeyResponse> {
  const res = await apiRequest<unknown>('/push/vapid-public-key');
  return VapidPublicKeyResponseSchema.parse(res);
}

/** 브라우저 구독 객체(PushSubscriptionJSON 부분)를 서버 등록 요청 형태로 변환한다. */
export function toSubscriptionRequest(json: {
  endpoint?: string | null;
  keys?: { p256dh?: string | null; auth?: string | null } | null;
}): PushSubscriptionRequest | null {
  const endpoint = json.endpoint ?? '';
  const p256dh = json.keys?.p256dh ?? '';
  const auth = json.keys?.auth ?? '';
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** 서버에 구독을 등록한다(upsert). */
export async function registerSubscription(req: PushSubscriptionRequest): Promise<void> {
  await apiRequest<void>('/me/push/subscriptions', { method: 'POST', body: req });
}

/** 서버에서 구독을 해제한다. */
export async function unregisterSubscription(endpoint: string): Promise<void> {
  await apiRequest<void>('/me/push/subscriptions', { method: 'DELETE', body: { endpoint } });
}

export interface EnablePushResult {
  /** 'granted' 외 결과(denied/unsupported/no-key)는 구독을 진행하지 않는다. */
  outcome: 'subscribed' | 'denied' | 'unsupported' | 'no-key';
}

/**
 * 사용자 제스처(버튼 클릭)에서만 호출한다. 권한 요청 → SW 등록 → 공개키 fetch → PushManager
 * 구독 → 서버 등록의 전체 흐름. 각 단계 실패는 outcome 으로 표현한다(throw 최소화 — 호출부가
 * 토스트로 안내). SW 등록 경로(swPath)는 기본 '/sw.js'(vite public).
 */
export async function enablePush(swPath = '/sw.js'): Promise<EnablePushResult> {
  const state = resolvePushPermission();
  if (state === 'unsupported') return { outcome: 'unsupported' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { outcome: 'denied' };

  const reg = await navigator.serviceWorker.register(swPath);
  await navigator.serviceWorker.ready;

  const { publicKey } = await fetchVapidPublicKey();
  if (!publicKey) return { outcome: 'no-key' };

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const req = toSubscriptionRequest(subscription.toJSON() as never);
  if (!req) return { outcome: 'no-key' };

  await registerSubscription(req);
  return { outcome: 'subscribed' };
}
