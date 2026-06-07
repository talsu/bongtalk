/**
 * S84b (D16 / FR-RC12): 봇/웹훅 rich embed 카드 렌더 검증.
 *   - color → border-left 인라인(content 색) + title/description/fields 렌더.
 *   - 안전치 않은 URL(비-http(s))은 링크/이미지를 떨군다(deep-defense).
 *   - 빈 배열/누락은 렌더 없음(null).
 * 순수 컴포넌트(훅 없음)라 renderToStaticMarkup 으로 정적 렌더한다.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RichEmbed } from '@qufox/shared-types';
import { RichEmbeds } from './RichEmbed';

function render(embeds?: RichEmbed[]) {
  return renderToStaticMarkup(<RichEmbeds embeds={embeds} />);
}

describe('RichEmbeds (FR-RC12)', () => {
  it('renders nothing for missing/empty arrays', () => {
    expect(render(undefined)).toBe('');
    expect(render([])).toBe('');
  });

  it('renders a card with color bar, title link, description and fields', () => {
    const html = render([
      {
        color: '#5865f2',
        title: 'Build #42',
        url: 'https://ci.example.com/42',
        description: 'passed',
        fields: [{ name: 'branch', value: 'main', inline: true }],
      },
    ]);
    expect(html).toContain('qf-embed');
    expect(html).toContain('border-left-color:#5865f2');
    expect(html).toContain('Build #42');
    expect(html).toContain('href="https://ci.example.com/42"');
    expect(html).toContain('passed');
    expect(html).toContain('branch');
    expect(html).toContain('main');
  });

  it('drops unsafe (non-http) title url but keeps the title text', () => {
    const html = render([{ title: 'Danger', url: 'javascript:alert(1)' as unknown as string }]);
    expect(html).toContain('Danger');
    expect(html).not.toContain('javascript:alert');
    // 안전치 않은 url 이면 <a> 가 아니라 <div> 로 렌더된다.
    expect(html).not.toContain('href="javascript');
  });

  it('renders author name and footer text', () => {
    const html = render([
      { author: { name: 'CI Bot' }, footer: { text: 'qufox-ci' }, description: 'x' },
    ]);
    expect(html).toContain('CI Bot');
    expect(html).toContain('qufox-ci');
  });
});
