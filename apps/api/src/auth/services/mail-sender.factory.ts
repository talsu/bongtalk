import { ConsoleMailSender, type MailSender } from './mail.service';
import { SmtpMailSender } from './smtp-mail.sender';
import { RateLimitService } from './rate-limit.service';

/**
 * feat(mail): MAIL_SENDER 구현 선택 팩토리.
 *
 * SMTP_HOST 가 설정돼 있으면 실발송(SmtpMailSender), 비어 있으면 ConsoleMailSender 폴백
 * (dev/test — 인증/초대 링크를 로그로 출력). 원 설계가 "어댑터 교체 시 한 곳만 바꾼다" 를
 * 명시했으므로 선택 로직을 팩토리 한 곳에 모은다(auth.module 의 useFactory 에서 호출).
 */
export function createMailSender(rate: RateLimitService): MailSender {
  if (process.env.SMTP_HOST) {
    return new SmtpMailSender(rate);
  }
  return new ConsoleMailSender();
}
