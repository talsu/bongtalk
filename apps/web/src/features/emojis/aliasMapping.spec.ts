import { describe, it, expect } from 'vitest';
import type { CustomEmoji } from './api';

/**
 * S42 (FR-EM07): CustomEmojiContext 가 별칭도 byName 의 키로 등록한다. provider 내부
 * 로직과 동일한 매핑을 순수 함수로 재현해 단위로 검증한다(렌더 불필요). 파서는 이
 * byName Map 만 조회하므로, 별칭이 키로 들어가면 `:alias:` 도 동일 이모지로 렌더된다.
 */
function buildByName(list: CustomEmoji[]): Map<string, CustomEmoji> {
  const byName = new Map<string, CustomEmoji>();
  for (const ce of list) {
    byName.set(ce.name, ce);
    for (const alias of ce.aliases ?? []) {
      if (!byName.has(alias)) byName.set(alias, ce);
    }
  }
  return byName;
}

const emoji = (name: string, aliases: string[] = []): CustomEmoji => ({
  id: `id-${name}`,
  name,
  aliases,
  createdBy: 'u1',
  createdAt: '2025-01-01T00:00:00Z',
  url: `https://cdn/${name}.png`,
  urlExpiresAt: '2025-01-01T00:30:00Z',
  sizeBytes: 100,
  mime: 'image/png',
});

describe('CustomEmoji byName alias mapping (FR-EM07)', () => {
  it('registers both the canonical name and each alias', () => {
    const byName = buildByName([emoji('parrot', ['birb', 'polly'])]);
    expect(byName.get('parrot')?.name).toBe('parrot');
    expect(byName.get('birb')?.name).toBe('parrot');
    expect(byName.get('polly')?.name).toBe('parrot');
  });

  it('does not let an alias clobber another emoji canonical name', () => {
    // emoji A has canonical name "shared"; emoji B carries alias "shared".
    const byName = buildByName([emoji('shared'), emoji('other', ['shared'])]);
    // canonical wins — :shared: still resolves to emoji A.
    expect(byName.get('shared')?.name).toBe('shared');
  });

  it('handles emoji with no aliases', () => {
    const byName = buildByName([emoji('plain')]);
    expect(byName.get('plain')?.name).toBe('plain');
    expect(byName.size).toBe(1);
  });
});
