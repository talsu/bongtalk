import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { SmtpMailSender, type SmtpTransport } from './smtp-mail.sender';
import { ConsoleMailSender } from './mail.service';
import { createMailSender } from './mail-sender.factory';
import type { RateLimitService } from './rate-limit.service';

/**
 * nodemailer 모듈을 hoisted mock 으로 대체한다(네임스페이스 export 는 non-configurable 라
 * vi.spyOn 으로 재정의 불가). createTransport 호출 인자(host/port/secure/requireTLS/auth)를
 * 단언하기 위한 seam — 실제 SMTP 연결은 발생하지 않는다.
 */
const createTransportMock = vi.hoisted(() => vi.fn());
vi.mock('nodemailer', () => ({ createTransport: createTransportMock }));

/**
 * feat(mail) — SmtpMailSender 단위 테스트.
 *
 * 외부 모킹 라이브러리 금지: nodemailer transport 는 생성자 seam 으로 vi.fn 스텁을 주입한다.
 * RateLimitService.hit 도 vi.fn 스텁(Redis 없이) 으로 대체한다. 전부 best-effort 계약
 * (throw 안 함) 을 검증한다.
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  createTransportMock.mockReset();
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
      // 전역(첫 hit) 만 초과시키기 위해 호출 순서로 count 를 제어한다.
      const hit = vi
        .fn()
        .mockResolvedValueOnce({ count: 26, ttl: 60 }) // 전역 cap 초과
        .mockResolvedValue({ count: 1, ttl: 60 }); // per-recipient 는 여유
      const rate = { hit } as unknown as RateLimitService;

      const sender = new SmtpMailSender(rate, transport);

      await expect(
        sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc'),
      ).resolves.toBeUndefined();

      expect(sendMail).not.toHaveBeenCalled();
    });

    it('per-recipient 쿼터 초과 시 sendMail 을 호출하지 않고 throw 하지 않는다 (shared-fate 완화)', async () => {
      const { transport, sendMail } = makeTransportStub();
      // 전역은 여유(첫 hit), per-recipient(둘째 hit) 만 초과시킨다.
      const hit = vi
        .fn()
        .mockResolvedValueOnce({ count: 1, ttl: 60 }) // 전역 cap 여유
        .mockResolvedValueOnce({ count: 6, ttl: 60 }); // per-recipient cap(5) 초과
      const rate = { hit } as unknown as RateLimitService;

      const sender = new SmtpMailSender(rate, transport);

      await expect(
        sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc'),
      ).resolves.toBeUndefined();

      expect(sendMail).not.toHaveBeenCalled();
      // per-recipient 키는 수신자 주소를 소문자로 정규화해 쓴다.
      const perRecipientHit = hit.mock.calls.find((c) =>
        String((c[0] as { key: string }).key).startsWith('email:send:to:'),
      );
      expect(perRecipientHit?.[0].key).toBe('email:send:to:user@example.com');
    });

    it('per-recipient 키는 수신자 주소를 소문자로 정규화한다', async () => {
      const { transport } = makeTransportStub();
      const hit = vi.fn().mockResolvedValue({ count: 1, ttl: 60 });
      const rate = { hit } as unknown as RateLimitService;
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendVerificationEmail('User@Example.COM', 'https://qufox.com/v?token=abc');

      const perRecipientHit = hit.mock.calls.find((c) =>
        String((c[0] as { key: string }).key).startsWith('email:send:to:'),
      );
      expect(perRecipientHit?.[0].key).toBe('email:send:to:user@example.com');
    });

    it('EMAIL_RATE_MAX 가 빈 문자열이면 기본값 25 로 폴백한다 (전체 드롭 방지)', async () => {
      process.env.EMAIL_RATE_MAX = '';
      const { transport, sendMail } = makeTransportStub();
      // 전역(첫 hit) count=10 → 빈값이 0 으로 파싱되면 10 > 0 이라 드롭되겠지만,
      // 기본 25 로 폴백되면 10 <= 25 라 발송된다. per-recipient(둘째 hit)는 여유(1).
      const hit = vi
        .fn()
        .mockResolvedValueOnce({ count: 10, ttl: 60 })
        .mockResolvedValue({ count: 1, ttl: 60 });
      const rate = { hit } as unknown as RateLimitService;
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc');

      expect(sendMail).toHaveBeenCalledTimes(1);
      const globalHit = hit.mock.calls.find((c) => (c[0] as { key: string }).key === 'email:send');
      expect((globalHit?.[0] as { max: number }).max).toBe(25);
    });

    it('EMAIL_RATE_DURATION_MS 가 빈 문자열이면 기본 윈도(3600초)로 폴백한다', async () => {
      process.env.EMAIL_RATE_DURATION_MS = '';
      const { transport } = makeTransportStub();
      const hit = vi.fn().mockResolvedValue({ count: 1, ttl: 60 });
      const rate = { hit } as unknown as RateLimitService;
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc');

      const globalHit = hit.mock.calls.find((c) => (c[0] as { key: string }).key === 'email:send');
      expect((globalHit?.[0] as { windowSec: number }).windowSec).toBe(3600);
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

  describe('subject 헤더 인젝션 방어 (CRLF sanitize)', () => {
    it('초대 메일 subject 에서 CR/LF 를 제거한다(헤더 인젝션 방어심층)', async () => {
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendWorkspaceInviteEmail(
        'invitee@example.com',
        'https://qufox.com/accept#token=xyz',
        'Acme\r\nBcc: attacker@evil.com',
        'MEMBER',
        'Alice',
      );

      const arg = sendMail.mock.calls[0][0];
      expect(arg.subject).not.toContain('\r');
      expect(arg.subject).not.toContain('\n');
      // 개행은 공백으로 치환되어 워크스페이스 텍스트는 보존된다.
      expect(arg.subject).toContain('Acme');
    });
  });

  describe('button href 스킴 검증 (메일 XSS 방어심층)', () => {
    it('https:// 링크는 그대로 둔다', async () => {
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc');

      const arg = sendMail.mock.calls[0][0];
      expect(arg.html).toContain('https://qufox.com/v?token=abc');
    });

    it('javascript: 스킴 href 는 # 으로 치환한다', async () => {
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendVerificationEmail('user@example.com', 'javascript:alert(1)');

      const arg = sendMail.mock.calls[0][0];
      expect(arg.html).not.toContain('javascript:alert(1)');
      expect(arg.html).toContain('href="#"');
    });

    it('http:// 링크는 허용한다', async () => {
      const { transport, sendMail } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendVerificationEmail('user@example.com', 'http://localhost:5173/v?token=abc');

      const arg = sendMail.mock.calls[0][0];
      expect(arg.html).toContain('http://localhost:5173/v?token=abc');
    });
  });

  describe('발송 로그 프라이버시 (subject → type 라벨)', () => {
    it('email_sent 로그에 subject 가 아닌 type 라벨을 남긴다', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');
      const { transport } = makeTransportStub();
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendWorkspaceInviteEmail(
        'invitee@example.com',
        'https://qufox.com/accept#token=xyz',
        'SecretWorkspaceName',
        'MEMBER',
        'Alice',
      );

      const payloads = logSpy.mock.calls.map((c) => String(c[0]));
      const sent = payloads.find((p) => p.includes('email_sent'));
      expect(sent).toBeDefined();
      expect(sent).not.toContain('SecretWorkspaceName');
      expect(sent).toContain('"type":"invite"');
    });

    it('email_send_failed 로그에 subject 가 아닌 type 라벨을 남긴다', async () => {
      const errSpy = vi.spyOn(Logger.prototype, 'error');
      const sendMail = vi.fn(async () => {
        throw new Error('SMTP down');
      });
      const transport = { sendMail } as unknown as SmtpTransport;
      const { rate } = makeRateStub();
      const sender = new SmtpMailSender(rate, transport);

      await sender.sendWorkspaceInviteEmail(
        'invitee@example.com',
        'https://qufox.com/accept#token=xyz',
        'SecretWorkspaceName',
        'MEMBER',
        'Alice',
      );

      const payloads = errSpy.mock.calls.map((c) => String(c[0]));
      const failed = payloads.find((p) => p.includes('email_send_failed'));
      expect(failed).toBeDefined();
      expect(failed).not.toContain('SecretWorkspaceName');
      expect(failed).toContain('"type":"invite"');
    });
  });

  describe('transport config (lazy createTransport 매핑)', () => {
    it('requireTLS:true 와 host/port/secure/auth 를 nodemailer 에 매핑한다', async () => {
      process.env.SMTP_HOST = 'mail.smtp2go.com';
      process.env.SMTP_PORT = '2525';
      process.env.SMTP_SECURE = 'false';
      process.env.SMTP_USER = 'smtp-user';
      process.env.SMTP_PASS = 'smtp-pass';

      const { sendMail } = makeTransportStub();
      createTransportMock.mockReturnValue({ sendMail });
      const { rate } = makeRateStub();

      // transport 미주입 → 첫 발송에서 lazy createTransport 호출.
      const sender = new SmtpMailSender(rate);
      await sender.sendVerificationEmail('user@example.com', 'https://qufox.com/v?token=abc');

      expect(createTransportMock).toHaveBeenCalledTimes(1);
      const cfg = createTransportMock.mock.calls[0][0] as {
        host?: string;
        port?: number;
        secure?: boolean;
        requireTLS?: boolean;
        auth?: { user?: string; pass?: string };
      };
      expect(cfg.host).toBe('mail.smtp2go.com');
      expect(cfg.port).toBe(2525);
      expect(cfg.secure).toBe(false);
      expect(cfg.requireTLS).toBe(true);
      expect(cfg.auth?.user).toBe('smtp-user');
      expect(cfg.auth?.pass).toBe('smtp-pass');
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
