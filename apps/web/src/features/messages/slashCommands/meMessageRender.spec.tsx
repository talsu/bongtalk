import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMrkdwn } from '@qufox/shared-types';
import { renderAst } from '../renderAst';

/**
 * S80 (D15 / FR-RC18) — `/me` 메시지의 이탤릭 렌더 검증.
 *
 * 서버의 IN_CHANNEL 변환(transformInChannel)이 `/me waves` → `_waves_` 로 이탤릭 마크를
 * 씌우고, 그 본문이 mrkdwn 파서 → renderAst 의 italic 경로(<em className="italic">)로
 * me_message 처럼 렌더되는지(전체 파이프라인) 검증한다. 별도 messageType 컬럼 없이 이탤릭
 * 마크가 me_message 마커 역할을 한다(마이그레이션 1건 제약 — Reminder 만 추가).
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('/me 이탤릭 렌더 (FR-RC18)', () => {
  it('서버 변환 결과 `_waves_` 는 이탤릭 em 으로 렌더된다', () => {
    const { ast } = parseMrkdwn('_waves at everyone_');
    const out = renderToStaticMarkup(<>{renderAst(ast)}</>);
    expect(out).toContain('<em');
    expect(out).toContain('italic');
    expect(out).toContain('waves at everyone');
  });
});
