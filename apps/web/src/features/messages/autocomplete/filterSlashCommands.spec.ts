import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandItem } from '@qufox/shared-types';
import { filterSlashCommands } from './filterSlashCommands';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function cmd(over: Partial<SlashCommandItem> & { name: string }): SlashCommandItem {
  return {
    id: `builtin:${over.name}`,
    description: '',
    usageHint: '',
    responseType: 'EPHEMERAL',
    handlerType: 'BUILTIN',
    isBuiltin: true,
    ...over,
  };
}

describe('filterSlashCommands (S79 / FR-SC-02) — 퍼지 필터', () => {
  const commands: SlashCommandItem[] = [
    cmd({ name: 'shrug', description: '어깨를 으쓱' }),
    cmd({ name: 'status', description: '상태 설정' }),
    cmd({ name: 'shortcuts', description: '단축키 보기' }),
    cmd({ name: 'dnd', description: 'do not disturb 방해 금지' }),
    cmd({ name: 'deploy', description: '배포', isBuiltin: false, id: 'uuid-deploy' }),
  ];

  it('query 가 없으면 전체를 limit 까지 반환한다', () => {
    expect(filterSlashCommands(commands, '', 10)).toHaveLength(5);
  });

  it('name prefix 매칭이 우선한다(sh → shrug/shortcuts)', () => {
    const out = filterSlashCommands(commands, 'sh', 10);
    expect(out.map((c) => c.name)).toEqual(['shortcuts', 'shrug']);
  });

  it('name 매칭(가중치 2)이 description 매칭(가중치 1)보다 앞선다', () => {
    // "status" 는 name 매치(+2), "dnd" 는 description("방해 금지")엔 없지만
    // "status" 만 매치되도록 쿼리. name 매치가 desc-only 매치보다 위.
    const list: SlashCommandItem[] = [
      cmd({ name: 'aaa', description: 'status 관련' }), // desc only +1
      cmd({ name: 'status', description: '상태' }), // name +2
    ];
    const out = filterSlashCommands(list, 'status', 10);
    expect(out[0].name).toBe('status');
  });

  it('빌트인이 커스텀보다 우선한다(동점 시)', () => {
    const list: SlashCommandItem[] = [
      cmd({ name: 'deploy', description: 'd', isBuiltin: false, id: 'uuid-x' }),
      cmd({ name: 'deploy2', description: 'd', isBuiltin: true }),
    ];
    // 둘 다 description 'd' 매치(+1, 동점) → 빌트인(deploy2) 우선.
    const out = filterSlashCommands(list, 'd', 10);
    expect(out[0].isBuiltin).toBe(true);
  });

  it('매칭이 없으면 빈 배열', () => {
    expect(filterSlashCommands(commands, 'zzz', 10)).toEqual([]);
  });

  it('limit 을 초과하지 않는다', () => {
    expect(filterSlashCommands(commands, '', 2)).toHaveLength(2);
  });

  it('description 으로도 매칭한다(보조)', () => {
    const out = filterSlashCommands(commands, '방해', 10);
    expect(out.map((c) => c.name)).toContain('dnd');
  });
});
