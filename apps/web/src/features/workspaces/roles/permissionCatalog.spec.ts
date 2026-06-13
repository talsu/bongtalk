import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from '@qufox/shared-types';
import { PERMISSION_CATALOG } from './permissionCatalog';

/**
 * 072-N5-2 (FR-RM05·06·07): 역할 권한 카탈로그가 모더레이션 비트(KICK/BAN/TIMEOUT)를
 * 노출하는지 회귀고정. 비트는 ADR-4 단일출처(PERMISSIONS) 재사용(재정의 금지).
 */
describe('PERMISSION_CATALOG — 모더레이션 비트(N5-2)', () => {
  it('KICK_MEMBERS/BAN_MEMBERS/TIMEOUT_MEMBERS 가 카탈로그에 포함된다', () => {
    const flags = PERMISSION_CATALOG.map((p) => p.flag);
    expect(flags).toContain('KICK_MEMBERS');
    expect(flags).toContain('BAN_MEMBERS');
    expect(flags).toContain('TIMEOUT_MEMBERS');
  });

  it('각 항목의 bit 은 PERMISSIONS 단일출처와 동일하다(재정의 없음)', () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.bit).toBe(PERMISSIONS[entry.flag]);
    }
  });

  it('모더레이션 항목은 한글 라벨을 갖는다', () => {
    const kick = PERMISSION_CATALOG.find((p) => p.flag === 'KICK_MEMBERS');
    expect(kick?.label).toBeTruthy();
    expect(kick?.label).not.toMatch(/^[A-Z_]+$/); // 영문 enum 이 아닌 한글 라벨
  });
});
