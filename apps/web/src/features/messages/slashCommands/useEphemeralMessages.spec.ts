import { beforeEach, describe, expect, it } from 'vitest';
import { useEphemeralStore } from './useEphemeralMessages';

/**
 * S80 (D15 / FR-SC-05) — 채널별 EPHEMERAL 스토어 단위 테스트.
 */
describe('useEphemeralStore', () => {
  beforeEach(() => {
    useEphemeralStore.setState({ byChannel: {} });
  });

  it('채널별로 메시지를 쌓는다', () => {
    const { push } = useEphemeralStore.getState();
    push({ channelId: 'c1', content: 'A', error: false });
    push({ channelId: 'c1', content: 'B', error: true });
    push({ channelId: 'c2', content: 'C', error: false });
    const state = useEphemeralStore.getState().byChannel;
    expect(state['c1']).toHaveLength(2);
    expect(state['c2']).toHaveLength(1);
    expect(state['c1'][1].error).toBe(true);
  });

  it('dismiss 는 해당 항목만 제거한다', () => {
    const { push } = useEphemeralStore.getState();
    push({ channelId: 'c1', content: 'A', error: false });
    push({ channelId: 'c1', content: 'B', error: false });
    const id = useEphemeralStore.getState().byChannel['c1'][0].id;
    useEphemeralStore.getState().dismiss('c1', id);
    const list = useEphemeralStore.getState().byChannel['c1'];
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('B');
  });

  it('clearChannel 은 한 채널만 정리한다(다른 채널 보존)', () => {
    const { push } = useEphemeralStore.getState();
    push({ channelId: 'c1', content: 'A', error: false });
    push({ channelId: 'c2', content: 'B', error: false });
    useEphemeralStore.getState().clearChannel('c1');
    const state = useEphemeralStore.getState().byChannel;
    expect(state['c1']).toBeUndefined();
    expect(state['c2']).toHaveLength(1);
  });
});
