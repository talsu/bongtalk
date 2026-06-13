import { describe, expect, it } from 'vitest';
import {
  WS_ICON_KEY_RE,
  WS_ICON_MAX_BYTES,
  WsIconPresignInputSchema,
  WsIconFinalizeInputSchema,
  WsIconPresignResultSchema,
  WsIconFinalizeResultSchema,
} from './profile';

/**
 * 072 백로그 S-C (FR-W01): 워크스페이스 아이콘 업로드 계약. ws아바타(member-profile)
 * 계약과 동형이되 키는 워크스페이스당 하나(`ws-icons/<wsId>/<file>` 3-세그먼트)다.
 */
describe('072 S-C workspace icon contract', () => {
  describe('WS_ICON_KEY_RE (traversal 차단)', () => {
    it('accepts a well-formed 3-segment ws-icon key', () => {
      expect(WS_ICON_KEY_RE.test('ws-icons/ws1/abc.png')).toBe(true);
      expect(WS_ICON_KEY_RE.test('ws-icons/ws1/a-b_c.1.webp')).toBe(true);
    });
    it('rejects traversal / wrong-prefix / extra-segment keys', () => {
      expect(WS_ICON_KEY_RE.test('ws-icons/ws1/../ws2/evil.png')).toBe(false);
      expect(WS_ICON_KEY_RE.test('ws-icons/../etc/passwd')).toBe(false);
      expect(WS_ICON_KEY_RE.test('ws-avatars/ws1/x.png')).toBe(false);
      expect(WS_ICON_KEY_RE.test('ws-icons/ws1/sub/x.png')).toBe(false);
    });
  });

  describe('WsIconPresignInputSchema', () => {
    it('accepts an allowed mime under the size cap', () => {
      expect(
        WsIconPresignInputSchema.safeParse({ contentType: 'image/png', sizeBytes: 1024 }).success,
      ).toBe(true);
    });
    it('rejects a disallowed mime (gif)', () => {
      expect(
        WsIconPresignInputSchema.safeParse({ contentType: 'image/gif', sizeBytes: 1024 }).success,
      ).toBe(false);
    });
    it('rejects oversize', () => {
      expect(
        WsIconPresignInputSchema.safeParse({
          contentType: 'image/webp',
          sizeBytes: WS_ICON_MAX_BYTES + 1,
        }).success,
      ).toBe(false);
    });
    it('rejects unknown keys (strict)', () => {
      expect(
        WsIconPresignInputSchema.safeParse({
          contentType: 'image/png',
          sizeBytes: 1024,
          extra: 1,
        }).success,
      ).toBe(false);
    });
  });

  describe('WsIconFinalizeInputSchema', () => {
    it('accepts a well-formed key, rejects empty / traversal / wrong-prefix keys', () => {
      expect(WsIconFinalizeInputSchema.safeParse({ key: 'ws-icons/ws1/x.png' }).success).toBe(true);
      expect(WsIconFinalizeInputSchema.safeParse({ key: '' }).success).toBe(false);
      expect(WsIconFinalizeInputSchema.safeParse({ key: 'a/b/c' }).success).toBe(false);
      expect(
        WsIconFinalizeInputSchema.safeParse({ key: 'ws-icons/ws1/../ws2/evil.png' }).success,
      ).toBe(false);
    });
  });

  describe('result schemas', () => {
    it('presign result carries key/url/fields/expiresAt', () => {
      const r = WsIconPresignResultSchema.safeParse({
        key: 'ws-icons/ws1/x.png',
        url: 'http://minio/bucket',
        fields: { key: 'ws-icons/ws1/x.png', policy: 'abc' },
        expiresAt: '2025-01-01T00:00:00.000Z',
      });
      expect(r.success).toBe(true);
    });
    it('finalize result carries iconUrl', () => {
      expect(WsIconFinalizeResultSchema.safeParse({ iconUrl: 'http://minio/get' }).success).toBe(
        true,
      );
    });
  });
});
