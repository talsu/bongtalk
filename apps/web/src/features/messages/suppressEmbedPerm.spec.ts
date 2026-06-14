import { describe, it, expect } from 'vitest';
import { deriveCanSuppressEmbed } from './suppressEmbedPerm';

/**
 * 072 백로그 S-F (FR-RC08 / N0-F4): suppress 버튼 노출 판정 — 서버 진실
 * (canManageMessages) + 작성자 비교. 채널 override 를 반영하는지(종전 클라 추정 제거).
 */
describe('deriveCanSuppressEmbed', () => {
  const base = { hasWorkspace: true, isTmpRow: false, isAuthor: false, canManageMessages: false };

  it('DM(워크스페이스 아님)은 항상 false', () => {
    expect(deriveCanSuppressEmbed({ ...base, hasWorkspace: false, isAuthor: true })).toBe(false);
    expect(deriveCanSuppressEmbed({ ...base, hasWorkspace: false, canManageMessages: true })).toBe(
      false,
    );
  });

  it('낙관적 tmp 행은 false(서버 임베드 미존재)', () => {
    expect(deriveCanSuppressEmbed({ ...base, isTmpRow: true, isAuthor: true })).toBe(false);
  });

  // 072 S-F 리뷰(LOW): early-return 게이트(hasWorkspace/isTmpRow)가 OR 절을 이긴다는
  // precedence 를 고정한다 — 추후 boolean 재배열 회귀를 막는다.
  it('tmp 행은 권한자(canManageMessages)여도 false(early-return 우선)', () => {
    expect(deriveCanSuppressEmbed({ ...base, isTmpRow: true, canManageMessages: true })).toBe(
      false,
    );
  });

  it('DM + tmp + 작성자 조합도 false(워크스페이스 게이트 우선)', () => {
    expect(
      deriveCanSuppressEmbed({ ...base, hasWorkspace: false, isTmpRow: true, isAuthor: true }),
    ).toBe(false);
  });

  it('작성자 본인은 권한 없어도 true', () => {
    expect(deriveCanSuppressEmbed({ ...base, isAuthor: true, canManageMessages: false })).toBe(
      true,
    );
  });

  it('비작성자라도 canManageMessages(채널 override 포함)면 true', () => {
    expect(deriveCanSuppressEmbed({ ...base, isAuthor: false, canManageMessages: true })).toBe(
      true,
    );
  });

  it('비작성자 + 권한 없음 → false(종전 viewerRole 추정 제거 — deny override 반영)', () => {
    expect(deriveCanSuppressEmbed({ ...base, isAuthor: false, canManageMessages: false })).toBe(
      false,
    );
  });
});
