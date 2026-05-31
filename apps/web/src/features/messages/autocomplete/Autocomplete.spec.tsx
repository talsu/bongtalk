import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Autocomplete } from './Autocomplete';
import type { AutocompleteRow } from './useAutocomplete';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function markup(
  kind: 'mention' | 'channel' | 'emoji',
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
});
