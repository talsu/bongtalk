import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar } from './Avatar';

describe('Avatar presence status', () => {
  it('online → qf-avatar__status--online span', () => {
    const html = renderToStaticMarkup(<Avatar name="dev_lee" status="online" />);
    expect(html).toContain('qf-avatar__status qf-avatar__status--online');
    expect(html).toContain('aria-label="온라인"');
  });

  it('dnd → qf-avatar__status--dnd span (task-018-D reserves the enum)', () => {
    const html = renderToStaticMarkup(<Avatar name="designer_kim" status="dnd" />);
    expect(html).toContain('qf-avatar__status qf-avatar__status--dnd');
    expect(html).toContain('aria-label="방해 금지"');
  });

  it('offline → no status span (caller fades the whole row)', () => {
    const html = renderToStaticMarkup(<Avatar name="eng_jung" status="offline" />);
    expect(html).not.toContain('qf-avatar__status');
  });

  it('omitted status → no status span (e.g. brand avatar in composer)', () => {
    const html = renderToStaticMarkup(<Avatar name="q" />);
    expect(html).not.toContain('qf-avatar__status');
  });
});
