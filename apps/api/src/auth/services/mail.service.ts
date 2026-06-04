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
    // 토큰/링크를 평문 출력하나, Console stub 은 dev/테스트 전용이며 운영에서는 SMTP
    // 어댑터로 교체된다(MinIO 네이밍 규칙처럼 구현 세부는 추후 어댑터 책임).
    this.logger.log(
      JSON.stringify({
        event: 'email_verification_sent',
        to,
        verifyUrl,
      }),
    );
  }
}
