import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * task-040 R3 contract: the body of useSendMessage.onError MUST call
 * useNotifications.getState().push with variant: 'danger'. This static
 * grep guards against silent removal of the toast call when someone
 * refactors the mutation later.
 */

describe('useSendMessage.onError surfaces send failure (task-040 R3 contract)', () => {
  it('useMessages.ts contains the danger toast push inside onError', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    const src = readFileSync(`${root}/apps/web/src/features/messages/useMessages.ts`, 'utf8');
    // collapse whitespace for indentation-tolerant matching
    const flat = src.replace(/\s+/g, ' ');
    expect(flat).toContain('onError:');
    expect(flat).toContain("variant: 'danger'");
    expect(flat).toContain("'메시지 전송 실패'");
    expect(flat).toMatch(/useNotifications\s*\.\s*getState\s*\(\s*\)\s*\.\s*push/);
  });
});
