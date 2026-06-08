import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpMailSender, type SmtpTransport } from './smtp-mail.sender';
import { ConsoleMailSender } from './mail.service';
import { createMailSender } from './mail-sender.factory';
import type { RateLimitService } from './rate-limit.service';

/**
 * feat(mail) — SmtpMailSender 단위 테스트.
 *
 * 외부 모킹 라이브러리 금지: nodemailer transport 는 생성자 seam 으로 vi.fn 스텁을 주입한다.
 * RateLimitService.hit 도 vi.fn 스텁(Redis 없이) 으로 대체한다. 전부 best-effort 계약
 * (throw 안 함) 을 검증한다.
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/** sendMail 을 vi.fn 으로 스텁한 nodemailer transport seam. */
function makeTransportStub(): { transport: SmtpTransport; sendMail: ReturnType<typeof vi.fn> } {
  const sendMail = vi.fn(async () => ({ messageId: 'test-message-id' }));
  return { transport: { sendMail } as unknown as SmtpTransport, sendMail };
}

/**
 * RateLimitService.hit 스텁. count 를 제어해 쿼터 초과 분기를 강제할 수 있다.
 * 기본은 count=1(여유) 이며 throw 하지 않는다(hit 계약).
 */
function makeRateStub(count = 1): {
  rate: RateLimitService;
  hit: ReturnType<typeof vi.fn>;
} {
  const hit = vi.fn(async () => ({ count, ttl: 60 }));
  return { rate: { hit } as unknown as RateLimitService, hit };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('SmtpMailSender', () => {
  describe('sendVerificationEmail', () => {
    it('from/to/subject/html/text 를 올바르게 sendMail 에 전달한다', async () => {
      process.env.MAIL_FROM = 'no-reply@qufox.com';
      process.env.EMAIL_RATE_MAX = '25';
      process.env.EMAIL_RATE_DURATION_MS = '3600000';
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();

      const sender = new SmtpMailSender(rate, transport);
      await sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc123');

      expect(sendMail).toHaveBeenCalledTimes(1);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.from).toBe('no-reply@qufox.com');
      expect(arg.to).toBe('user@example.com');
      expect(arg.subject).toContain('이메일 인증');
      expect(arg.html).toContain('https://qufox.com/v?token=abc123');
      expect(arg.text).toContain('https://qufox.com/v?token=abc123');
    });
  });

  describe('sendWorkspaceInviteEmail', () => {
    it('초대 메일 subject 에 워크스페이스 이름이 들어간다', async () => {
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendWorkspaceInviteEmail(
        'invitee@example.com',
        'https://qufox.com/accept#token=xyz',
        'Acme',
        'MEMBER',
        'Alice',
      );

      expect(sendMail).toHaveBeenCalledTimes(1);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.subject).toContain('Acme');
      expect(arg.html).toContain('Alice');
      expect(arg.html).toContain('https://qufox.com/accept#token=xyz');
    });

    it('workspaceName 의 HTML 특수문자를 이스케이프한다(XSS 방지)', async () => {
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendWorkspaceInviteEmail(
        'invitee@example.com',
        'https://qufox.com/accept#token=xyz',
        '<script>alert(1)</script>',
        'MEMBER',
        '<b>Mallory</b>',
      );

      const arg = sendMail.mock.calls[0][0];
      expect(arg.html).not.toContain('<script>alert(1)</script>');
      expect(arg.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(arg.html).not.toContain('<b>Mallory</b>');
      expect(arg.html).toContain('&lt;b&gt;Mallory&lt;/b&gt;');
    });
  });

  describe('sendSecurityAlertEmail', () => {
    it('보안 알림 메일을 발송한다', async () => {
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendSecurityAlertEmail('user@example.com', 'password_changed');

      expect(sendMail).toHaveBeenCalledTimes(1);
      const arg = sendMail.mock.calls[0][0];
      expect(arg.subject).toContain('보안 알림');
      expect(arg.html).toContain('password_changed');
    });

    it('event 의 HTML 특수문자를 이스케이프한다', async () => {
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendSecurityAlertEmail('user@example.com', '<img src=x onerror=1>');

      const arg = sendMail.mock.calls[0][0];
      expect(arg.html).not.toContain('<img src=x onerror=1>');
      expect(arg.html).toContain('&lt;img src=x onerror=1&gt;');
    });
  });

  describe('rate-limit (best-effort)', () => {
    it('전역 쿼터 초과 시 sendMail 을 호출하지 않고 throw 하지 않는다', async () => {
      process.env.EMAIL_RATE_MAX = '25';
      const { transport, sendMail } = makeTransportStub();
      const { rate, hit } = makeRateStub(26); // count > max

      const sender = new SmtpMailSender(rate, transport);

      await expect(
        sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc'),
      ).resolves.toBeUndefined();

      expect(hit).toHaveBeenCalledTimes(1);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('rate.hit 이 reject 해도 throw 하지 않고 발송을 시도한다(best-effort)', async () => {
      const { transport, sendMail } = makeTransportStub();
      const hit = vi.fn(async () => {
        throw new Error('redis down');
      });
      const rate = { hit } as unknown as RateLimitService;
      const sender = new SmtpMailSender(rate, transport);

      await expect(
        sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc'),
      ).resolves.toBeUndefined();
      // hit 실패는 전송을 막지 않는다(best-effort, fail-open).
      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendMail 실패 (best-effort)', () => {
    it('transport.sendMail reject 시 error 로그 후 throw 하지 않는다', async () => {
      const sendMail = vi.fn(async () => {
        throw new Error('SMTP 535 auth failed');
      });
      const transport = { sendMail } as unknown as SmtpTransport;
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await expect(
        sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc'),
      ).resolves.toBeUndefined();
      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createMailSender (factory)', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('SMTP_HOST 가 설정되면 SmtpMailSender 를 반환한다', () => {
    process.env.SMTP_HOST = 'mail.smtp2go.com';
    const rate = { hit: vi.fn() } as unknown as RateLimitService;
    expect(createMailSender(rate)).toBeInstanceOf(SmtpMailSender);
  });

  it('SMTP_HOST 가 비면 ConsoleMailSender 폴백', () => {
    delete process.env.SMTP_HOST;
    const rate = { hit: vi.fn() } as unknown as RateLimitService;
    expect(createMailSender(rate)).toBeInstanceOf(ConsoleMailSender);
  });

  it('SMTP_HOST 가 빈 문자열이면 ConsoleMailSender 폴백', () => {
    process.env.SMTP_HOST = '';
    const rate = { hit: vi.fn() } as unknown as RateLimitService;
    expect(createMailSender(rate)).toBeInstanceOf(ConsoleMailSender);
  });
});
