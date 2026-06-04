import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacesService } from './workspaces.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S68 (D13 / FR-W05 · Fork C): emailDomains PATCH OWNER 게이트 + 정규화 단위 테스트.
 * update() 가 DB 에 닿기 전 게이트를 평가하므로 update 호출을 캡처하는 가벼운 스텁만 둔다.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function makeService() {
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'ws',
    ...args.data,
  }));
  const prisma = {
    workspace: { update, findUnique: vi.fn(async () => null) },
  };
  const svc = new WorkspacesService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, update };
}

describe('S68 WorkspacesService.update — emailDomains OWNER gate', () => {
  it('rejects an ADMIN emailDomains PATCH with WORKSPACE_EMAIL_DOMAINS_FORBIDDEN', async () => {
    const { svc, update } = makeService();
    await expect(svc.update('ws', { emailDomains: ['acme.com'] }, 'ADMIN')).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_EMAIL_DOMAINS_FORBIDDEN,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a MEMBER emailDomains PATCH', async () => {
    const { svc } = makeService();
    await expect(svc.update('ws', { emailDomains: [] }, 'MEMBER')).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it('allows an OWNER emailDomains PATCH and normalizes + dedupes', async () => {
    const { svc, update } = makeService();
    await svc.update('ws', { emailDomains: ['Acme.COM', ' acme.com ', 'beta.io'] }, 'OWNER');
    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0][0].data as { emailDomains: string[] };
    expect(data.emailDomains).toEqual(['acme.com', 'beta.io']);
  });

  it('does not touch emailDomains when omitted (ADMIN name-only PATCH allowed)', async () => {
    const { svc, update } = makeService();
    await svc.update('ws', { name: 'New name' }, 'ADMIN');
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect('emailDomains' in data).toBe(false);
    expect(data.name).toBe('New name');
  });

  it('allows clearing the whitelist (empty array) as OWNER', async () => {
    const { svc, update } = makeService();
    await svc.update('ws', { emailDomains: [] }, 'OWNER');
    const data = update.mock.calls[0][0].data as { emailDomains: string[] };
    expect(data.emailDomains).toEqual([]);
  });
});
