import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { MailSender } from './mail.service';
import { RateLimitService } from './rate-limit.service';

/**
 * feat(mail): SMTP2GO 메일 실발송 어댑터.
 *
 * S66 의 ConsoleMailSender(stub) 를 대체하는 nodemailer SMTP 릴레이 구현. MailSender 인터페이스
 * 계약을 그대로 보존한다 — 즉 **best-effort**(절대 throw 하지 않음). 발송 실패/쿼터 초과는
 * logger.error 로 남기고 조용히 반환한다. 호출처(email-verification / pending-invites /
 * account-security)는 await 하지만 throw 를 가정하지 않으므로, 메일 실패가 본 도메인 트랜잭션
 * (회원가입·초대·비밀번호 변경)을 깨지 않게 하기 위함이다.
 *
 * SMTP 설정은 ConfigModule 없이 process.env 직독(프로젝트 현행 관례). 환경 키:
 * SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / MAIL_FROM /
 * EMAIL_RATE_MAX / EMAIL_RATE_DURATION_MS. (env 정수는 빈값/garbage 가 0/NaN 으로 파싱돼
 * 전체 발송이 드롭되지 않도록 envInt 가드로 안전 기본값을 적용한다.)
 *
 * 보안 fix-forward 적용: STARTTLS 다운그레이드 차단(requireTLS), per-recipient 보조 rate-limit
 * (shared-fate DoS 완화), subject CRLF sanitize(헤더 인젝션), 버튼 href 스킴 검증(메일 XSS),
 * 발송 로그에서 subject 제거 → type 라벨(프라이버시).
 */

/**
 * nodemailer transport 의 테스트 seam — sendMail 한 메서드만 의존한다. 생성자로 스텁을 주입해
 * 단위 테스트에서 vi.fn 으로 sendMail 을 모킹할 수 있게 한다(외부 모킹 라이브러리 금지).
 */
export interface SmtpTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
}

/**
 * 발송 로그 분류 라벨(F5). subject(workspaceName 등 민감 입력 포함)를 로그에 남기는 대신
 * 이 라벨만 남겨 수신자↔워크스페이스 매핑 노출을 줄인다.
 */
type EmailType = 'verification' | 'invite' | 'security';

/**
 * 보안(F2): 동일 수신자 주소에 대한 보조 발송 상한. 전역 cap(EMAIL_RATE_MAX) 만으로는
 * 한 종류/주소 남용이 전체 메일을 차단하는 shared-fate DoS 를 막지 못하므로, 수신자별
 * 작은 cap 을 추가로 둔다(동일 주소 스팸/shared-fate 완화). env 가 아닌 코드 상수로 둔다
 * (사용자 스펙: 전역만 env 1쌍). 윈도는 전역과 동일 윈도를 공유한다.
 */
const EMAIL_PER_RECIPIENT_MAX = 5;

@Injectable()
export class SmtpMailSender implements MailSender {
  private readonly logger = new Logger(SmtpMailSender.name);
  /** lazy singleton transport — 첫 발송 시 1회 생성한다(생성자 주입 시 그 값을 사용). */
  private transport: SmtpTransport | undefined;

  constructor(
    private readonly rate: RateLimitService,
    /** 테스트 seam: 미주입 시 첫 발송에서 nodemailer.createTransport 로 lazy 생성한다. */
    injectedTransport?: SmtpTransport,
  ) {
    this.transport = injectedTransport;
  }

  /** lazy singleton: process.env 기반 nodemailer transport 를 1회만 생성한다. */
  private getTransport(): SmtpTransport {
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: envInt(process.env.SMTP_PORT, 587),
        secure: process.env.SMTP_SECURE === 'true',
        // 보안(F1): STARTTLS 경로(secure:false·2525/587)에서 서버가 STARTTLS 미광고/MITM strip
        // 시 평문 폴백을 차단한다. requireTLS 면 TLS 업그레이드 실패 시 발송을 거부(자격증명
        // 평문 전송 방지). SMTP2GO 2525/587 은 항상 STARTTLS 를 제공하므로 정상 연결엔 영향 없다.
        // secure:true(465) 경로는 처음부터 TLS 라 이 옵션의 영향이 없다.
        requireTLS: true,
        auth: {
          user: process.env.SMTP_USER ?? '',
          pass: process.env.SMTP_PASS ?? '',
        },
      }) as unknown as SmtpTransport;
    }
    return this.transport;
  }

  /**
   * 공통 발송 경로. rate-limit(best-effort) → sendMail(best-effort). 어떤 실패도 throw 하지
   * 않는다. 토큰/시크릿/subject 는 로그에 남기지 않는다(to + type + 사유만).
   *
   * rate-limit 은 2개 cap 을 hit 한다(F2):
   *  ① 전역 `email:send`(릴레이 쿼터/전체 남용 방지, max=EMAIL_RATE_MAX)
   *  ② per-recipient `email:send:to:<소문자 주소>`(동일 주소 스팸/shared-fate 완화, max=상수 5)
   * 둘 중 하나라도 초과면 warn(어느 cap 인지) 후 스킵한다(throw 안 함).
   */
  private async send(
    to: string,
    type: EmailType,
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    // rate-limit 백엔드(Redis) 장애는 발송을 차단하지 않는다(fail-open). RateLimitService.hit 은
    // 계약상 throw 하지 않지만, Redis 장애 등으로 reject 할 수 있으므로 전체를 try 로 감싼다.
    try {
      // F6: 빈 문자열/garbage env 가 0/NaN 으로 파싱돼 모든 메일이 드롭되는 것을 막는다.
      const globalMax = envInt(process.env.EMAIL_RATE_MAX, 25);
      const windowSec = Math.max(
        1,
        Math.floor(envInt(process.env.EMAIL_RATE_DURATION_MS, 3600000) / 1000),
      );

      // ① 전역 cap.
      const global = await this.rate.hit({ key: 'email:send', windowSec, max: globalMax });
      if (global.count > globalMax) {
        this.logger.warn(
          JSON.stringify({
            event: 'email_send_skipped',
            to,
            type,
            reason: 'global_rate_limit_exceeded',
            count: global.count,
            max: globalMax,
          }),
        );
        return;
      }

      // ② per-recipient cap(동일 주소 spam/shared-fate 완화). 주소는 소문자로 정규화한 키를 쓴다.
      const perRecipient = await this.rate.hit({
        key: `email:send:to:${to.toLowerCase()}`,
        windowSec,
        max: EMAIL_PER_RECIPIENT_MAX,
      });
      if (perRecipient.count > EMAIL_PER_RECIPIENT_MAX) {
        this.logger.warn(
          JSON.stringify({
            event: 'email_send_skipped',
            to,
            type,
            reason: 'per_recipient_rate_limit_exceeded',
            count: perRecipient.count,
            max: EMAIL_PER_RECIPIENT_MAX,
          }),
        );
        return;
      }
    } catch (err) {
      // fail-open: rate-limit 점검 실패는 발송을 막지 않는다. 흔적만 남긴다.
      this.logger.warn(
        JSON.stringify({
          event: 'email_rate_check_failed',
          to,
          type,
          reason: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }

    try {
      await this.getTransport().sendMail({
        from: process.env.MAIL_FROM ?? '',
        to,
        subject,
        text,
        html,
      });
      // F5: subject(workspaceName 등 민감 입력) 대신 type 라벨만 남긴다.
      this.logger.log(JSON.stringify({ event: 'email_sent', to, type }));
    } catch (err) {
      // best-effort: 발송 실패가 도메인 트랜잭션을 깨지 않게 흔적만 남기고 조용히 반환한다.
      this.logger.error(
        JSON.stringify({
          event: 'email_send_failed',
          to,
          type,
          reason: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }
  }

  async sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
    // 정적 subject 라 인젝션 표면은 없지만 일관성을 위해 sanitize 를 통과시킨다(F3).
    const subject = sanitizeHeader('[qufox] 이메일 인증을 완료해 주세요');
    const text = [
      'qufox 가입을 환영합니다.',
      '',
      '아래 링크를 클릭해 이메일 인증을 완료해 주세요.',
      verifyUrl,
      '',
      '본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다.',
    ].join('\n');
    const html = layout(
      '이메일 인증',
      `
      <p>qufox 가입을 환영합니다.</p>
      <p>아래 버튼을 눌러 이메일 인증을 완료해 주세요.</p>
      ${button(verifyUrl, '이메일 인증하기')}
      <p style="font-size:12px;color:#888;">본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다.</p>
      `,
    );
    await this.send(to, 'verification', subject, text, html);
  }

  async sendWorkspaceInviteEmail(
    to: string,
    inviteUrl: string,
    workspaceName: string,
    role: string,
    inviterName: string,
  ): Promise<void> {
    // 사용자 입력은 HTML escape(메일 클라이언트 렌더 — XSS 방지).
    const safeWorkspace = escapeHtml(workspaceName);
    const safeRole = escapeHtml(role);
    const safeInviter = escapeHtml(inviterName);

    // F3: 사용자 입력(workspaceName)을 subject 에 넣기 전 CR/LF 제거(헤더 인젝션 방어심층).
    const subject = sanitizeHeader(`[qufox] ${workspaceName} 워크스페이스 초대`);
    const text = [
      `${inviterName} 님이 회원님을 '${workspaceName}' 워크스페이스에 ${role} 역할로 초대했습니다.`,
      '',
      '아래 링크에서 초대를 수락해 주세요.',
      inviteUrl,
    ].join('\n');
    const html = layout(
      `${safeWorkspace} 워크스페이스 초대`,
      `
      <p><strong>${safeInviter}</strong> 님이 회원님을 <strong>${safeWorkspace}</strong> 워크스페이스에 <strong>${safeRole}</strong> 역할로 초대했습니다.</p>
      <p>아래 버튼을 눌러 초대를 수락해 주세요.</p>
      ${button(inviteUrl, '초대 수락하기')}
      `,
    );
    await this.send(to, 'invite', subject, text, html);
  }

  async sendSecurityAlertEmail(to: string, event: string): Promise<void> {
    const safeEvent = escapeHtml(event);
    // 정적 subject 지만 일관성을 위해 sanitize 를 통과시킨다(F3).
    const subject = sanitizeHeader('[qufox] 보안 알림');
    const text = [
      `회원님의 계정에서 보안 관련 활동이 감지되었습니다: ${event}`,
      '',
      '본인이 수행한 활동이 맞다면 별도 조치는 필요하지 않습니다.',
      '본인이 아니라면 즉시 비밀번호를 변경하고 고객센터에 문의해 주세요.',
    ].join('\n');
    const html = layout(
      '보안 알림',
      `
      <p>회원님의 계정에서 보안 관련 활동이 감지되었습니다.</p>
      <p>활동: <strong>${safeEvent}</strong></p>
      <p>본인이 수행한 활동이 맞다면 별도 조치는 필요하지 않습니다.</p>
      <p style="color:#c0392b;">본인이 아니라면 즉시 비밀번호를 변경하고 고객센터에 문의해 주세요.</p>
      `,
    );
    await this.send(to, 'security', subject, text, html);
  }
}

/**
 * F6: env 정수 파싱 가드. 빈 문자열은 Number('')===0, garbage 는 NaN 이 되어 잘못된 cap/윈도로
 * 전체 발송이 드롭될 수 있다. 유한·양수일 때만 채택하고 그 외엔 안전 기본값을 쓴다.
 */
function envInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * F3: 메일 헤더(subject)에 들어갈 값에서 CR/LF 를 제거한다(헤더 인젝션 방어심층). nodemailer 가
 * 자체적으로 fold/검증하지만, 중간 MTA 엣지 케이스를 대비해 사용자 입력이 닿는 헤더를 직접 정리한다.
 */
function sanitizeHeader(input: string): string {
  return input.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * F4: 버튼 href 스킴 검증(메일 XSS 방어심층). http(s) 외 스킴(javascript:/data: 등)은 '#' 으로
 * 치환한다. 현재 verifyUrl/inviteUrl 은 서버 생성이라 안전하나, 재사용/회귀를 대비한 방어심층이다.
 */
function safeButtonHref(href: string): string {
  return /^https?:\/\//i.test(href) ? href : '#';
}

/** 최소 HTML escape — 메일 클라이언트에서 사용자 입력이 마크업으로 해석되는 것을 막는다. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 공통 메일 레이아웃(인라인 스타일 최소). title 은 호출처에서 escape 후 전달한다. */
function layout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="ko"><body style="margin:0;padding:24px;font-family:sans-serif;color:#1a1a1a;">
  <div style="max-width:480px;margin:0 auto;">
    <h1 style="font-size:18px;margin:0 0 16px;">${title}</h1>
    ${bodyHtml}
  </div>
</body></html>`;
}

/**
 * URL 버튼. F4: href 스킴을 먼저 검증(http(s) 외엔 '#')한 뒤 escape 한다(속성 인젝션 + XSS 방어심층).
 */
function button(href: string, label: string): string {
  const safeHref = escapeHtml(safeButtonHref(href));
  return `<p><a href="${safeHref}" style="display:inline-block;padding:10px 20px;background:#5865f2;color:#fff;text-decoration:none;border-radius:6px;">${escapeHtml(
    label,
  )}</a></p>
  <p style="font-size:12px;color:#888;word-break:break-all;">버튼이 작동하지 않으면 아래 주소를 복사해 주세요:<br>${safeHref}</p>`;
}
