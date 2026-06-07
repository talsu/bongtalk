import { Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';
import type { PushNotificationPayload, PushSubscriptionRequest } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';

/**
 * S86 (D16 / FR-MN-15): Web Push(VAPID) 전송 코어.
 *
 * 책임:
 *   - VAPID 자격(env) 1회 setVapidDetails. 키 부재면 graceful no-op(+1회 warn) — 키 없는
 *     dev/test 에서도 앱이 동작하고 구독/조회 REST 는 정상 작동한다(전송만 비활성).
 *   - upsert/remove 구독(userId 스코프 — 본인 구독만).
 *   - sendToUser: 사용자의 유효 구독 전부에 web-push 전송. 404/410(stale endpoint) 응답
 *     구독은 즉시 GC(삭제). 그 외 오류는 비-치명으로 warn(전송 best-effort).
 *
 * web-push HTTP 전송은 라이브러리가 담당하며, 단위 테스트는 sendNotification 을 vi.fn()
 * 으로 주입(setWebPushSender)해 실제 push service 호출 없이 게이트/GC 분기를 검증한다.
 */

/** web-push 전송 함수 시그니처(테스트 주입 가능 — 실 HTTP 호출 격리). */
export type WebPushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<{ statusCode: number }>;

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private vapidConfigured = false;
  private vapidWarned = false;
  // 테스트 주입 지점. 기본은 web-push.sendNotification 래퍼.
  private sender: WebPushSender = (sub, payload) =>
    webpush.sendNotification(sub as webpush.PushSubscription, payload);

  constructor(private readonly prisma: PrismaService) {
    this.configureVapid();
  }

  /**
   * 단위 테스트 전용: 실 HTTP 전송 대신 mock 을 주입한다(실 push service 호출 금지).
   * 주입 즉시 vapidConfigured 를 true 로 간주(키 없이도 게이트/GC 분기 검증 가능).
   */
  setWebPushSender(sender: WebPushSender): void {
    this.sender = sender;
    this.vapidConfigured = true;
  }

  /** VAPID 자격(env)을 1회 설정한다. 키 부재면 no-op(전송 시 graceful skip). */
  private configureVapid(): void {
    const publicKey = process.env.VAPID_PUBLIC_KEY ?? '';
    const privateKey = process.env.VAPID_PRIVATE_KEY ?? '';
    const subject = process.env.VAPID_SUBJECT ?? '';
    if (!publicKey || !privateKey || !subject) {
      this.vapidConfigured = false;
      return;
    }
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.vapidConfigured = true;
    } catch (err) {
      // 잘못된 키 형식 등 — 크래시 금지. 전송 경로에서 no-op 로 흐른다.
      this.vapidConfigured = false;
      this.logger.warn(`[push] setVapidDetails failed: ${String(err).slice(0, 160)}`);
    }
  }

  /** GET /push/vapid-public-key 가 내려줄 공개키(미설정이면 빈 문자열). */
  publicKey(): string {
    return process.env.VAPID_PUBLIC_KEY ?? '';
  }

  /**
   * POST /me/push/subscriptions: endpoint 기준 upsert(userId 스코프). 같은 endpoint 가
   * 다른 사용자에 묶여 있었다면(기기 공유/재로그인) 소유자를 갱신한다(endpoint @unique).
   * 키 회전·재허용 시 p256dh/auth 도 갱신된다.
   *
   * S86 리뷰(MEDIUM-1) 수용 근거: endpoint 전역 @unique 는 "물리적 push endpoint 1개 =
   * 전달 대상 1개" 의미상 올바르다(두 사용자가 같은 endpoint 를 가지면 서로의 알림이 섞임).
   * 재로그인 시 소유자 갱신은 표준 web-push 패턴이다. 타 사용자 endpoint 탈취 위험은,
   * endpoint 가 push service 가 발급한 추측 불가 토큰 URL 이고(목록 노출 엔드포인트 없음)
   * SSRF allowlist(shared-types isAllowedPushEndpoint)로 임의 URL 등록도 막혀 있어,
   * 공격자가 피해자의 실제 endpoint 를 알아낼 경로가 없다(잔여 위험 무시 가능).
   */
  async upsertSubscription(
    userId: string,
    sub: PushSubscriptionRequest,
    ua?: string | null,
  ): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        ua: ua ?? null,
      },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        ua: ua ?? null,
      },
    });
  }

  /**
   * DELETE /me/push/subscriptions: endpoint 로 해제. userId 동봉(deleteMany)으로 본인
   * 구독만 삭제(타인 endpoint 추측 삭제 차단). 없으면 no-op.
   */
  async removeSubscription(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  /**
   * 사용자의 유효 구독 전부에 페이로드를 전송한다. VAPID 미설정이면 graceful no-op
   * (+1회 warn). 각 구독은 독립 전송하며, 404/410 응답은 stale endpoint 로 보고 즉시
   * 삭제(GC)한다. 그 외 오류는 비-치명 warn(전송 best-effort — 알림 전달 실패가 잡을
   * 실패시키지 않게 throw 하지 않는다). 반환: 전송 성공 구독 수(진단용).
   */
  async sendToUser(userId: string, payload: PushNotificationPayload): Promise<number> {
    if (!this.vapidConfigured) {
      if (!this.vapidWarned) {
        this.vapidWarned = true;
        this.logger.warn(
          '[push] VAPID env 미설정 — push 전송을 건너뜁니다(graceful no-op). VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT 를 설정하세요.',
        );
      }
      return 0;
    }

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subs.length === 0) return 0;

    const body = JSON.stringify(payload);
    const staleIds: string[] = [];
    const sentIds: string[] = [];
    let sent = 0;

    await Promise.all(
      subs.map(async (s) => {
        try {
          await this.sender(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
          );
          sent += 1;
          sentIds.push(s.id);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // 만료/해지된 구독 — push service 가 더는 받지 않는다. GC 대상.
            staleIds.push(s.id);
          } else {
            this.logger.warn(
              `[push] send failed user=${userId} endpoint=${s.endpoint.slice(0, 48)}… status=${status ?? '?'} err=${String(err).slice(0, 120)}`,
            );
          }
        }
      }),
    );

    if (staleIds.length > 0) {
      await this.prisma.pushSubscription
        .deleteMany({ where: { id: { in: staleIds } } })
        .catch((err) => this.logger.warn(`[push] stale GC failed: ${String(err).slice(0, 120)}`));
    }

    // S86 리뷰 fix-forward (NIT): 실제 전송 성공한 구독만 lastUsedAt 갱신(종전엔 userId
    // 전체 갱신 — 진단/GC 정확도 저하). best-effort·실패 무시.
    if (sentIds.length > 0) {
      await this.prisma.pushSubscription
        .updateMany({ where: { id: { in: sentIds } }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }

    return sent;
  }
}
