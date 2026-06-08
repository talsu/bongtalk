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
 * EMAIL_RATE_MAX / EMAIL_RATE_DURATION_MS.
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
        port: Number(process.env.SMTP_PORT ?? '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER ?? '',
          pass: process.env.SMTP_PASS ?? '',
        },
      }) as unknown as SmtpTransport;
    }
    return this.transport;
  }

  /**
   * 공통 발송 경로. 전역 rate-limit(best-effort) → sendMail(best-effort). 어떤 실패도 throw 하지
   * 않는다. 토큰/시크릿은 로그에 남기지 않는다(to + 사유만).
   */
  private async send(to: string, subject: string, text: string, html: string): Promise<void> {
    // 전역 발송 상한(릴레이 쿼터/남용 방지). RateLimitService.hit 은 throw 하지 않지만(계약),
    // Redis 장애 등으로 reject 할 수 있으므로 fail-open 으로 감싼다(메일 발송을 막지 않음).
    try {
      const max = Number(process.env.EMAIL_RATE_MAX ?? '25');
      const windowSec = Math.max(
        1,
        Math.floor(Number(process.env.EMAIL_RATE_DURATION_MS ?? '3600000') / 1000),
      );
      const { count } = await this.rate.hit({ key: 'email:send', windowSec, max });
      if (count > max) {
        this.logger.error(
          JSON.stringify({
            event: 'email_send_skipped',
            to,
            reason: 'global_rate_limit_exceeded',
            count,
            max,
          }),
        );
        return;
      }
    } catch (err) {
      // rate-limit 백엔드(Redis) 장애는 발송을 차단하지 않는다(fail-open). 흔적만 남긴다.
      this.logger.warn(
        JSON.stringify({
          event: 'email_rate_check_failed',
          to,
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
      this.logger.log(JSON.stringify({ event: 'email_sent', to, subject }));
    } catch (err) {
      // best-effort: 발송 실패가 도메인 트랜잭션을 깨지 않게 흔적만 남기고 조용히 반환한다.
      this.logger.error(
        JSON.stringify({
          event: 'email_send_failed',
          to,
          subject,
          reason: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }
  }

  async sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
    const subject = '[qufox] 이메일 인증을 완료해 주세요';
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
    await this.send(to, subject, text, html);
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

    const subject = `[qufox] ${workspaceName} 워크스페이스 초대`;
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
    await this.send(to, subject, text, html);
  }

  async sendSecurityAlertEmail(to: string, event: string): Promise<void> {
    const safeEvent = escapeHtml(event);
    const subject = '[qufox] 보안 알림';
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
    await this.send(to, subject, text, html);
  }
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

/** URL 버튼. href 는 escape 한다(메일 본문 내 속성 인젝션 방지). */
function button(href: string, label: string): string {
  const safeHref = escapeHtml(href);
  return `<p><a href="${safeHref}" style="display:inline-block;padding:10px 20px;background:#5865f2;color:#fff;text-decoration:none;border-radius:6px;">${escapeHtml(
    label,
  )}</a></p>
  <p style="font-size:12px;color:#888;word-break:break-all;">버튼이 작동하지 않으면 아래 주소를 복사해 주세요:<br>${safeHref}</p>`;
}
