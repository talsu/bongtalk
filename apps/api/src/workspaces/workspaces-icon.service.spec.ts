import { describe, expect, it, vi } from 'vitest';
import { WorkspacesService } from './workspaces.service';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * 072 백로그 S-C (FR-W01) 적대 리뷰(LOW) fix-forward: 아이콘 presign/finalize/delete +
 * presign-on-read 의 도메인 분기 단위 커버(CLAUDE.md — 도메인 서비스 100%). S3/Prisma 는
 * vi.fn() 스텁(외부 모킹 라이브러리 금지). 시스템 시간 고정(harness 규약).
 */
vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

// PNG 매직(89 50 4E 47 0D 0A 1A 0A) + 패딩 — finalize 성공 경로의 magic 검증 통과용.
const PNG_HEAD = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0,
]);

type Stubs = {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  headObject: ReturnType<typeof vi.fn>;
  getObjectRange: ReturnType<typeof vi.fn>;
  presignGet: ReturnType<typeof vi.fn>;
  presignPost: ReturnType<typeof vi.fn>;
  deleteObject: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
};

function makeService(over: Partial<Stubs> = {}): { svc: WorkspacesService; s: Stubs } {
  const s: Stubs = {
    findUnique: over.findUnique ?? vi.fn(async () => ({ iconUrl: null })),
    update: over.update ?? vi.fn(async () => ({})),
    headObject:
      over.headObject ?? vi.fn(async () => ({ contentLength: 1024, contentType: 'image/png' })),
    getObjectRange: over.getObjectRange ?? vi.fn(async () => PNG_HEAD),
    presignGet: over.presignGet ?? vi.fn(async () => 'https://minio.local/signed-get'),
    presignPost:
      over.presignPost ?? vi.fn(async () => ({ url: 'https://minio.local', fields: { k: 'v' } })),
    deleteObject: over.deleteObject ?? vi.fn(async () => undefined),
    invalidate: over.invalidate ?? vi.fn(async () => undefined),
  };
  const prisma = { workspace: { findUnique: s.findUnique, update: s.update } };
  const s3 = {
    headObject: s.headObject,
    getObjectRange: s.getObjectRange,
    presignGet: s.presignGet,
    presignPost: s.presignPost,
    deleteObject: s.deleteObject,
  };
  const discoverCache = { invalidate: s.invalidate };
  const svc = new WorkspacesService(
    prisma as never,
    {} as never, // outbox
    {} as never, // memberRoles
    {} as never, // moderation
    {} as never, // passwords
    discoverCache as never,
    {} as never, // ipSoftBlock
    s3 as never,
  );
  return { svc, s };
}

describe('WorkspacesService.presignIconUrl (presign-on-read)', () => {
  it('null → null (아이콘 미설정)', async () => {
    const { svc, s } = makeService();
    await expect(svc.presignIconUrl(null)).resolves.toBeNull();
    expect(s.presignGet).not.toHaveBeenCalled();
  });

  it('http(s) 레거시 절대 URL 은 presign 없이 그대로 통과', async () => {
    const { svc, s } = makeService();
    await expect(svc.presignIconUrl('https://cdn.example.com/x.png')).resolves.toBe(
      'https://cdn.example.com/x.png',
    );
    expect(s.presignGet).not.toHaveBeenCalled();
  });

  it('storageKey 는 presigned GET URL 로 변환', async () => {
    const { svc, s } = makeService();
    await expect(svc.presignIconUrl('ws-icons/ws1/a.png')).resolves.toBe(
      'https://minio.local/signed-get',
    );
    expect(s.presignGet).toHaveBeenCalledWith('ws-icons/ws1/a.png', { expiresIn: 600 });
  });
});

describe('WorkspacesService.presignIcon (presign 발급 검증)', () => {
  it('허용되지 않은 MIME 은 INVALID_MIME', async () => {
    const { svc } = makeService();
    await expect(svc.presignIcon('ws1', 'image/gif', 1024)).rejects.toMatchObject({
      code: ErrorCode.INVALID_MIME,
    });
  });

  it('0 이하 크기는 VALIDATION_FAILED', async () => {
    const { svc } = makeService();
    await expect(svc.presignIcon('ws1', 'image/png', 0)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('상한 초과는 FILE_TOO_LARGE', async () => {
    const { svc } = makeService();
    await expect(svc.presignIcon('ws1', 'image/png', 9 * 1024 * 1024)).rejects.toMatchObject({
      code: ErrorCode.FILE_TOO_LARGE,
    });
  });

  it('유효 입력은 key/url/fields/expiresAt 반환 + 키가 ws-icons/<wsId>/ prefix', async () => {
    const { svc } = makeService();
    const r = await svc.presignIcon('ws1', 'image/png', 1024);
    expect(r.key.startsWith('ws-icons/ws1/')).toBe(true);
    expect(r.key.endsWith('.png')).toBe(true);
    expect(r.url).toBe('https://minio.local');
    expect(r.fields).toEqual({ k: 'v' });
  });
});

describe('WorkspacesService.finalizeIcon (확정 검증 게이트)', () => {
  it('경로 traversal(..) 키는 FORBIDDEN (s3 미접근)', async () => {
    const { svc, s } = makeService();
    await expect(svc.finalizeIcon('ws1', 'ws-icons/ws1/../ws2/evil.png')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    expect(s.headObject).not.toHaveBeenCalled();
  });

  it('다른 워크스페이스 prefix 키는 FORBIDDEN (IDOR 차단)', async () => {
    const { svc } = makeService();
    await expect(svc.finalizeIcon('ws1', 'ws-icons/ws2/a.png')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('업로드 미도달(head null)은 INVALID_FILE', async () => {
    const { svc } = makeService({ headObject: vi.fn(async () => null) });
    await expect(svc.finalizeIcon('ws1', 'ws-icons/ws1/a.png')).rejects.toMatchObject({
      code: ErrorCode.INVALID_FILE,
    });
  });

  it('상한 초과 업로드는 FILE_TOO_LARGE + best-effort 정리', async () => {
    const del = vi.fn(async () => undefined);
    const { svc } = makeService({
      headObject: vi.fn(async () => ({ contentLength: 9 * 1024 * 1024, contentType: 'image/png' })),
      deleteObject: del,
    });
    await expect(svc.finalizeIcon('ws1', 'ws-icons/ws1/a.png')).rejects.toMatchObject({
      code: ErrorCode.FILE_TOO_LARGE,
    });
    expect(del).toHaveBeenCalledWith('ws-icons/ws1/a.png');
  });

  it('허용 외 선언 MIME 은 INVALID_MIME + 정리', async () => {
    const del = vi.fn(async () => undefined);
    const { svc } = makeService({
      headObject: vi.fn(async () => ({ contentLength: 1024, contentType: 'image/gif' })),
      deleteObject: del,
    });
    await expect(svc.finalizeIcon('ws1', 'ws-icons/ws1/a.png')).rejects.toMatchObject({
      code: ErrorCode.INVALID_MIME,
    });
    expect(del).toHaveBeenCalled();
  });

  it('magic 불일치는 INVALID_MAGIC_BYTES + 정리', async () => {
    const del = vi.fn(async () => undefined);
    const { svc } = makeService({
      getObjectRange: vi.fn(async () => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])),
      deleteObject: del,
    });
    await expect(svc.finalizeIcon('ws1', 'ws-icons/ws1/a.png')).rejects.toMatchObject({
      code: ErrorCode.INVALID_MAGIC_BYTES,
    });
    expect(del).toHaveBeenCalled();
  });

  it('성공: iconUrl=key 저장 + discover 캐시 무효화 + presigned URL 반환', async () => {
    const { svc, s } = makeService({ findUnique: vi.fn(async () => ({ iconUrl: null })) });
    const r = await svc.finalizeIcon('ws1', 'ws-icons/ws1/a.png');
    expect(s.update).toHaveBeenCalledWith({
      where: { id: 'ws1' },
      data: { iconUrl: 'ws-icons/ws1/a.png' },
    });
    expect(s.invalidate).toHaveBeenCalled();
    expect(r.iconUrl).toBe('https://minio.local/signed-get');
  });

  it('성공 시 이전 storageKey 는 best-effort 삭제하지만 http 레거시 값은 보존', async () => {
    const del = vi.fn(async () => undefined);
    // 이전 키가 storageKey 면 삭제.
    const a = makeService({
      findUnique: vi.fn(async () => ({ iconUrl: 'ws-icons/ws1/old.png' })),
      deleteObject: del,
    });
    await a.svc.finalizeIcon('ws1', 'ws-icons/ws1/new.png');
    expect(del).toHaveBeenCalledWith('ws-icons/ws1/old.png');

    // 이전 값이 http 절대 URL 이면 MinIO 객체가 아니므로 삭제하지 않는다.
    const del2 = vi.fn(async () => undefined);
    const b = makeService({
      findUnique: vi.fn(async () => ({ iconUrl: 'https://cdn.example.com/old.png' })),
      deleteObject: del2,
    });
    await b.svc.finalizeIcon('ws1', 'ws-icons/ws1/new.png');
    expect(del2).not.toHaveBeenCalled();
  });
});

describe('WorkspacesService.deleteIcon (멱등 + http 보존)', () => {
  it('iconUrl 이 없으면 멱등 no-op(update/삭제/무효화 미발생)', async () => {
    const { svc, s } = makeService({ findUnique: vi.fn(async () => ({ iconUrl: null })) });
    await svc.deleteIcon('ws1');
    expect(s.update).not.toHaveBeenCalled();
    expect(s.deleteObject).not.toHaveBeenCalled();
    expect(s.invalidate).not.toHaveBeenCalled();
  });

  it('storageKey 면 iconUrl=null 리셋 + 객체 삭제 + 캐시 무효화', async () => {
    const { svc, s } = makeService({
      findUnique: vi.fn(async () => ({ iconUrl: 'ws-icons/ws1/a.png' })),
    });
    await svc.deleteIcon('ws1');
    expect(s.update).toHaveBeenCalledWith({ where: { id: 'ws1' }, data: { iconUrl: null } });
    expect(s.deleteObject).toHaveBeenCalledWith('ws-icons/ws1/a.png');
    expect(s.invalidate).toHaveBeenCalled();
  });

  it('http 레거시 값이면 컬럼만 리셋하고 MinIO 삭제는 건너뜀', async () => {
    const { svc, s } = makeService({
      findUnique: vi.fn(async () => ({ iconUrl: 'https://cdn.example.com/a.png' })),
    });
    await svc.deleteIcon('ws1');
    expect(s.update).toHaveBeenCalledWith({ where: { id: 'ws1' }, data: { iconUrl: null } });
    expect(s.deleteObject).not.toHaveBeenCalled();
  });
});
