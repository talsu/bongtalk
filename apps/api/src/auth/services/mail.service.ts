import { Injectable, Logger } from '@nestjs/common';

/**
 * S66 (D13 / FR-W05b): 메일 발송 추상화.
 *
 * 사용자 결정(S66): 메일 발송은 Console stub 단일 구현으로 시작한다. 컨테이너 추가·
 * SMTP 패키지 설치 없이 인터페이스만 깔끔히 정의해, 나중에 SMTP 어댑터(ConsoleMailSender
 * → SmtpMailSender)로 교체할 수 있게 한다. NestJS provider 토큰 MAIL_SENDER 로 주입한다.
 */
export interface MailSender {
  /**
   * 이메일 인증 메일 발송. Console stub 은 verifyUrl/토큰을 Pino 로거로 출력한다.
   * @param to      수신자 이메일.
   * @param verifyUrl  GET /auth/verify-email?token=… 링크(절대 URL).
   */
  sendVerificationEmail(to: string, verifyUrl: string): Promise<void>;

  /**
   * S68 (D13 / FR-W04 · Fork B): 워크스페이스 이메일 직접 초대 메일.
   *
   * 사용자 결정(S68 Fork B): Console stub 만 유지한다. SMTP 컨테이너/nodemailer 도입은
   * 후속 슬라이스이며 본 슬라이스는 인터페이스만 정의한다. inviteUrl 엔 rawToken 이
   * 실리므로(미가입 분기는 opaque 교환 URL) prod 에서는 토큰을 마스킹해 로그에 남긴다.
   *
   * @param to            수신자 이메일.
   * @param inviteUrl     수락/가입 안내 링크(절대 URL). rawToken 또는 opaque 코드를 포함.
   * @param workspaceName 초대된 워크스페이스 이름(메일 본문 안내용).
   * @param role          부여 예정 역할(MEMBER/GUEST).
   * @param inviterName   초대자 표시 이름.
   */
  sendWorkspaceInviteEmail(
    to: string,
    inviteUrl: string,
    workspaceName: string,
    role: string,
    inviterName: string,
  ): Promise<void>;

  /**
   * S77b (D14 / FR-PS-15): 보안 알림 메일(비밀번호 변경 등 민감 액션 발생 시 등록 이메일로
   * 통지). Console stub 은 이벤트/사유를 구조화 로그로 출력한다. SMTP 실발송은 후속(S77c+).
   *
   * @param to     수신자 이메일(등록 이메일).
   * @param event  알림 사유(예: 'password_changed').
   */
  sendSecurityAlertEmail(to: string, event: string): Promise<void>;

  /**
   * AUTH-3 (PRD D18 §5 / FR-AUTH-40~44): 비밀번호 재설정 메일. POST /auth/forgot-password 가
   * 활성 사용자에게만 발송한다(계정 열거 방어 — 미존재/비활성은 발송 자체를 하지 않고 200).
   * resetUrl 엔 raw 토큰이 실리므로(WEB_URL/reset-password?token=…) verifyUrl 과 동일하게
   * 운영 로그에서는 토큰을 마스킹한다. Console stub 은 dev 에서 링크를 그대로 출력한다.
   *
   * @param to        수신자 이메일.
   * @param resetUrl  POST /auth/reset-password 로 이어지는 절대 URL(reset-password?token=raw).
   */
  sendPasswordResetEmail(to: string, resetUrl: string): Promise<void>;
}

/** DI 토큰 — MailSender 구현 주입에 쓴다(인터페이스는 런타임 토큰이 될 수 없음). */
export const MAIL_SENDER = Symbol('MAIL_SENDER');

/**
 * S66: 단일 Console stub 구현. 실제 메일을 보내지 않고 verifyUrl 을 구조화 로그로
 * 출력한다(dev/테스트에서 인증 링크를 그대로 확인 가능). 운영 SMTP 교체 전까지의
 * 임시 구현이며, 인터페이스(MailSender)는 교체에 영향받지 않는다.
 */
@Injectable()
export class ConsoleMailSender implements MailSender {
  private readonly logger = new Logger(ConsoleMailSender.name);

  async sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
    // S66 fix-forward (review HIGH-4): 운영(NODE_ENV=production)에서는 verifyUrl/토큰
    // 전체를 로그에 남기지 않는다. Console stub 은 본래 dev 편의용이라 운영에서 토큰이
    // 평문으로 로그(Loki/stdout)에 노출되면 그 자체로 계정 탈취 표면이 된다. 운영에서는
    // 토큰 끝 6자만 마스킹 노출하고, SMTP 어댑터 미설정 상태임을 warn 으로 알린다.
    if (process.env.NODE_ENV === 'production') {
      this.logger.warn(
        JSON.stringify({
          event: 'email_verification_sent',
          to,
          tokenTail: maskToken(verifyUrl),
          note: 'email sender not configured (console stub)',
        }),
      );
      return;
    }
    // 비-운영(dev/test)에서는 인증 링크를 그대로 출력해 수동 검증을 돕는다.
    this.logger.log(
      JSON.stringify({
        event: 'email_verification_sent',
        to,
        verifyUrl,
      }),
    );
  }

  /**
   * S68 (D13 / FR-W04 · Fork B): 워크스페이스 초대 메일 Console stub.
   *
   * S68 fix-forward (security MEDIUM-3): inviteUrl(rawToken 포함) 평문 로그는 **development
   * 에서만** 출력한다. 종전 `NODE_ENV !== 'production'` 게이트는 test(NODE_ENV=test) 와 미설정
   * 환경에서도 rawToken 을 평문 로그로 남겨 누출 표면이 됐다(테스트 로그 수집/CI 아티팩트 등).
   * dev 가 아닌 모든 환경(test 포함·미설정)은 토큰 끝 6자만 마스킹 노출한다(★핵심 AC: rawToken
   * 로그 평문 미노출).
   */
  async sendWorkspaceInviteEmail(
    to: string,
    inviteUrl: string,
    workspaceName: string,
    role: string,
    inviterName: string,
  ): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      // dev 편의 — 수동 수락을 위해 링크를 그대로 출력한다.
      this.logger.log(
        JSON.stringify({
          event: 'workspace_invite_sent',
          to,
          workspaceName,
          role,
          inviterName,
          inviteUrl,
        }),
      );
      return;
    }
    this.logger.warn(
      JSON.stringify({
        event: 'workspace_invite_sent',
        to,
        workspaceName,
        role,
        inviterName,
        tokenTail: maskInviteUrl(inviteUrl),
        note: 'email sender not configured (console stub)',
      }),
    );
  }

  /**
   * S77b (D14 / FR-PS-15): 보안 알림 메일 Console stub. 비밀번호 변경 같은 민감 액션 발생
   * 시 등록 이메일로 통지한다(시크릿/토큰 미포함이라 환경별 마스킹 불요). SMTP 실발송은 후속.
   */
  async sendSecurityAlertEmail(to: string, event: string): Promise<void> {
    this.logger.warn(
      JSON.stringify({
        event: 'security_alert_sent',
        to,
        reason: event,
        note: 'email sender not configured (console stub)',
      }),
    );
  }

  /**
   * AUTH-3 (PRD D18 §5 / FR-AUTH-40~44): 비밀번호 재설정 메일 Console stub. resetUrl 엔 raw
   * 토큰이 실리므로 sendVerificationEmail(HIGH-4) 과 동일한 환경별 마스킹을 적용한다 —
   * development 외(test 포함·미설정)에서는 토큰 끝 6자만 마스킹 노출(평문 토큰 로그 금지).
   */
  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      // dev 편의 — 수동 검증을 위해 링크를 그대로 출력한다.
      this.logger.log(
        JSON.stringify({
          event: 'password_reset_sent',
          to,
          resetUrl,
        }),
      );
      return;
    }
    this.logger.warn(
      JSON.stringify({
        event: 'password_reset_sent',
        to,
        tokenTail: maskToken(resetUrl),
        note: 'email sender not configured (console stub)',
      }),
    );
  }
}

/**
 * S66 fix-forward (review HIGH-4): verifyUrl 의 token 쿼리 끝 6자만 노출하는 마스킹.
 * 운영 로그에서 토큰 전체 노출을 막되, 발송 흔적 추적은 가능하게 한다(끝 6자).
 */
function maskToken(verifyUrl: string): string {
  const match = /token=([^&]+)/.exec(verifyUrl);
  const token = match?.[1] ?? '';
  if (token.length <= 6) return `***${token}`;
  return `***${token.slice(-6)}`;
}

/**
 * S68 (D13 / FR-W04): 워크스페이스 초대 inviteUrl 의 토큰 끝 6자만 노출하는 마스킹.
 * rawToken/opaque 코드 전체 노출을 막되 발송 흔적 추적은 가능하게 한다.
 *
 * S68 fix-forward (security MEDIUM-1): acceptUrl 이 rawToken 을 URL **fragment**(#token=…)로
 * 옮겼으므로 fragment 의 token 도 우선 추출한다. 쿼리(?token=…/?code=…)·path 끝 segment
 * 형태도 하위호환으로 함께 처리한다(어느 형태든 토큰성 문자열의 꼬리만 노출).
 */
function maskInviteUrl(inviteUrl: string): string {
  const fragMatch = /#(?:.*&)?(?:token|code)=([^&]+)/.exec(inviteUrl);
  const queryMatch = /[?&](?:token|code)=([^&#]+)/.exec(inviteUrl);
  const pathTail = inviteUrl.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
  const candidate = fragMatch?.[1] ?? queryMatch?.[1] ?? pathTail;
  if (candidate.length <= 6) return `***${candidate}`;
  return `***${candidate.slice(-6)}`;
}
