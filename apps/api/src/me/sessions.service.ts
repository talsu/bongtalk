import { Injectable } from '@nestjs/common';
import type { SessionSummary } from '@qufox/shared-types';
import { TokenService } from '../auth/services/token.service';

/**
 * S77b (D14 / FR-PS-15): 활성 세션(RefreshToken) 목록 + 개별/전체 로그아웃.
 *
 * 세션 = RefreshToken family(★A=RefreshToken 재사용 결정). isCurrent 는 현재 요청의 refresh
 * 쿠키가 매핑되는 familyId 와 비교해 판별한다. revoke 는 TokenService 의 기존 로직을 재사용한다.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly tokens: TokenService) {}

  /** 활성 세션 목록을 SessionSummary 로 변환한다. currentFamilyId 와 일치하면 isCurrent. */
  async listSessions(userId: string, currentFamilyId: string | null): Promise<SessionSummary[]> {
    const rows = await this.tokens.listSessions(userId);
    return rows.map((r) => ({
      id: r.id,
      deviceName: deviceNameFromUserAgent(r.userAgent),
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: (r.lastSeenAt ?? null)?.toISOString() ?? null,
      isCurrent: currentFamilyId !== null && r.familyId === currentFamilyId,
    }));
  }

  /** 개별 세션 로그아웃(본인 소유 검증 · 없으면 SESSION_NOT_FOUND). */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.tokens.revokeSession(userId, sessionId);
  }

  /** 현재 세션을 제외한 전체 로그아웃. revoke 된 세션 수를 반환한다. */
  async revokeAllExceptCurrent(userId: string, currentFamilyId: string | null): Promise<number> {
    return this.tokens.revokeAllExceptFamily(userId, currentFamilyId);
  }
}

/**
 * userAgent 문자열에서 사람이 읽을 deviceName 을 추출한다(브라우저 + OS 요약). 파싱 라이브러리
 * 없이 잘 알려진 토큰만 가볍게 매칭하고, 미상이면 raw 문자열을 그대로 반환한다(PLAN: "userAgent
 * 파싱 또는 raw"). null/빈 문자열은 null.
 */
export function deviceNameFromUserAgent(ua: string | null): string | null {
  if (!ua || ua.trim().length === 0) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (browser && os) return `${browser} · ${os}`;
  if (browser) return browser;
  if (os) return os;
  // 미상 — raw 를 과하지 않게 자른다(120자).
  return ua.length > 120 ? `${ua.slice(0, 117)}...` : ua;
}
