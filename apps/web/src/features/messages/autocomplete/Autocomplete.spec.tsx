import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Autocomplete } from './Autocomplete';
import type { AutocompleteRow } from './useAutocomplete';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function markup(
  kind: 'mention' | 'channel' | 'emoji' | 'slash',
  rows: AutocompleteRow[],
  active = 0,
): string {
  return renderToStaticMarkup(
    <Autocomplete
      kind={kind}
      rows={rows}
      activeIndex={active}
      listboxId="lb"
      optionId={(i) => `lb-opt-${i}`}
      maxHeight={320}
      onSelect={() => {}}
      onHover={() => {}}
    />,
  );
}

describe('Autocomplete — WAI-ARIA listbox 정합 (S18 A11y)', () => {
  it('renders role=listbox + role=option with stable option ids', () => {
    const rows: AutocompleteRow[] = [
      { type: 'member', member: { userId: 'u1', username: 'alice' }, online: true },
    ];
    const html = markup('mention', rows);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="lb"');
    expect(html).toContain('role="option"');
    expect(html).toContain('id="lb-opt-0"');
    expect(html).toContain('aria-selected="true"');
  });

  // S88a review F7 (a11y/ui): @ 트리거는 멤버 + 멘션 가능 역할을 함께 노출하므로
  // listbox aria-label·섹션 헤더가 '멤버 및 역할' 로 읽혀야 한다(단일 출처
  // TRIGGER_KIND_LABEL.mention).
  it('mention listbox surfaces "멤버 및 역할" in aria-label and header (F7)', () => {
    const rows: AutocompleteRow[] = [
      { type: 'member', member: { userId: 'u1', username: 'alice' }, online: true },
    ];
    const html = markup('mention', rows);
    expect(html).toContain('aria-label="멤버 및 역할 자동완성"');
    expect(html).toContain('멤버 및 역할');
  });

  // S88a review F13 (ui): role 행은 colorHex 가 null 이어도 meta 슬롯을 렌더해 멤버
  // 행과 우측 정렬을 맞춘다(슬롯 미렌더 시 정렬 어긋남).
  it('role row keeps the meta slot even when colorHex is null (F13)', () => {
    const withColor: AutocompleteRow[] = [
      {
        type: 'role',
        role: { id: 'r1', name: 'PM', colorHex: '#ff0000', mentionable: true },
      },
    ];
    const noColor: AutocompleteRow[] = [
      {
        type: 'role',
        role: { id: 'r2', name: 'Devs', colorHex: null, mentionable: true },
      },
    ];
    // 둘 다 meta 슬롯(__meta)과 점(__meta-dot)을 렌더한다.
    expect(markup('mention', withColor)).toContain('qf-autocomplete__meta');
    const noColorHtml = markup('mention', noColor);
    expect(noColorHtml).toContain('qf-autocomplete__meta');
    expect(noColorHtml).toContain('qf-autocomplete__meta-dot');
    // colorHex=null 이면 disabled 토큰 색 placeholder 로 채운다.
    expect(noColorHtml).toContain('var(--text-disabled)');
  });

  it('A-05: member rows expose online state as sr-only text (not colour-only)', () => {
    const online: AutocompleteRow[] = [
      { type: 'member', member: { userId: 'u1', username: 'alice' }, online: true },
    ];
    const offline: AutocompleteRow[] = [
      { type: 'member', member: { userId: 'u2', username: 'bob' }, online: false },
    ];
    expect(markup('mention', online)).toContain('온라인');
    expect(markup('mention', offline)).toContain('오프라인');
  });

  it('A-04: emoji glyph/img is aria-hidden so the shortcode is the accessible name', () => {
    const unicode: AutocompleteRow[] = [
      { type: 'emoji', emoji: { kind: 'unicode', name: 'tada', glyph: '🎉' } },
    ];
    const html = markup('emoji', unicode);
    // 글리프를 감싼 avatar 가 aria-hidden, shortcode 는 그대로 노출.
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(':tada:');
  });

  it('custom emoji image uses empty alt (shortcode provides the name)', () => {
    const custom: AutocompleteRow[] = [
      { type: 'emoji', emoji: { kind: 'custom', name: 'parrot', url: 'https://cdn/p.png' } },
    ];
    const html = markup('emoji', custom);
    expect(html).toContain('alt=""');
    expect(html).toContain(':parrot:');
  });

  it('S79 (FR-SC-02): slash Row 는 /이름·설명·usage hint 를 렌더하고 섹션 라벨이 슬래시 커맨드', () => {
    const rows: AutocompleteRow[] = [
      {
        type: 'slash',
        command: {
          id: 'builtin:shrug',
          name: 'shrug',
          description: '어깨를 으쓱',
          usageHint: '/shrug [메시지]',
          responseType: 'IN_CHANNEL',
          handlerType: 'BUILTIN',
          isBuiltin: true,
        },
      },
    ];
    const html = markup('slash', rows);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    // 섹션 헤더 + aria-label 에 한국어 명사.
    expect(html).toContain('슬래시 커맨드');
    expect(html).toContain('/shrug');
    expect(html).toContain('어깨를 으쓱');
    expect(html).toContain('/shrug [메시지]');
  });

  it('S79 fix-forward (a11y B-01): slash row 는 --slash 변형 클래스를 달아 선택상태 대비 override 의 스코프가 된다', () => {
    const rows: AutocompleteRow[] = [
      {
        type: 'slash',
        command: {
          id: 'builtin:shrug',
          name: 'shrug',
          description: '어깨를 으쓱',
          usageHint: '/shrug [메시지]',
          responseType: 'IN_CHANNEL',
          handlerType: 'BUILTIN',
          isBuiltin: true,
        },
      },
    ];
    const html = markup('slash', rows);
    // 채널 골격 + 슬래시 전용 변형(app-layer index.css 의 대비 override 가 이 클래스에만 걸린다).
    expect(html).toContain('qf-autocomplete__item--slash');
    expect(html).toContain('qf-autocomplete__item--channel');
  });

  it('S79 fix-forward (a11y H-01): slash option 은 aria-label 로 의미를 전달하고 usageHint meta 는 aria-hidden', () => {
    const rows: AutocompleteRow[] = [
      {
        type: 'slash',
        command: {
          id: 'builtin:shrug',
          name: 'shrug',
          description: '어깨를 으쓱',
          usageHint: '/shrug [메시지]',
          responseType: 'IN_CHANNEL',
          handlerType: 'BUILTIN',
          isBuiltin: true,
        },
      },
    ];
    const html = markup('slash', rows);
    // 단일 접근명: "슬래시 커맨드 /shrug, 어깨를 으쓱, 사용법 /shrug [메시지]".
    expect(html).toContain(
      'aria-label="슬래시 커맨드 /shrug, 어깨를 으쓱, 사용법 /shrug [메시지]"',
    );
    // usageHint 를 담은 meta 슬롯은 aria-hidden 이라 aria-label 과 중복 낭독되지 않는다.
    expect(html).toContain('aria-hidden="true"');
  });

  it('S79 fix-forward (a11y H-01): 설명 없는 커맨드도 최소 "슬래시 커맨드 /name" aria-label 을 갖는다', () => {
    const rows: AutocompleteRow[] = [
      {
        type: 'slash',
        command: {
          id: 'ws:custom',
          name: 'deploy',
          description: '',
          usageHint: '',
          responseType: 'EPHEMERAL',
          handlerType: 'INTERNAL_ACTION',
          isBuiltin: false,
        },
      },
    ];
    const html = markup('slash', rows);
    expect(html).toContain('aria-label="슬래시 커맨드 /deploy"');
  });
});
