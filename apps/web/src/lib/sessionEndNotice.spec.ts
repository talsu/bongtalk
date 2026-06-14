// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  markSessionEnded,
  consumeSessionEndedReason,
  clearSessionEndedReason,
} from './sessionEndNotice';

/**
 * 072 백로그 S-H (N6-3): 비자발적 세션 종료 사유 mark/consume/clear.
 * StrictMode-안전 1-shot: 같은 페이지-로드 내 반복 consume 는 동일 값(이중 마운트 대비),
 * 새 markSessionEnded / clearSessionEndedReason 가 캐시를 리셋한다. clearSessionEndedReason 로
 * 모듈 상태 전체(캐시+storage)를 초기화해 테스트를 격리한다.
 */
describe('sessionEndNotice', () => {
  beforeEach(() => clearSessionEndedReason());

  it('mark 한 사유를 consume 으로 읽는다', () => {
    markSessionEnded('expired');
    expect(consumeSessionEndedReason()).toBe('expired');
  });

  it('같은 로드 내 반복 consume 은 동일 값(StrictMode 이중 마운트 안전)', () => {
    markSessionEnded('revoked');
    expect(consumeSessionEndedReason()).toBe('revoked');
    // 두 번째 호출도 같은 값 — storage 는 비었지만 모듈 캐시가 1-shot 을 보존한다.
    expect(consumeSessionEndedReason()).toBe('revoked');
  });

  it('mark 없이 consume 하면 null', () => {
    expect(consumeSessionEndedReason()).toBeNull();
  });

  it('새 markSessionEnded 는 캐시를 리셋해 새 사유를 읽게 한다', () => {
    markSessionEnded('expired');
    expect(consumeSessionEndedReason()).toBe('expired');
    markSessionEnded('revoked');
    expect(consumeSessionEndedReason()).toBe('revoked');
  });

  it('clearSessionEndedReason 후 consume 은 null(능동 비활성화 억제 경로)', () => {
    markSessionEnded('revoked');
    clearSessionEndedReason();
    expect(consumeSessionEndedReason()).toBeNull();
  });

  it('유효하지 않은 값이 저장돼 있으면 null + 제거', () => {
    window.sessionStorage.setItem('qufox:sessionEnded', 'bogus');
    expect(consumeSessionEndedReason()).toBeNull();
    expect(window.sessionStorage.getItem('qufox:sessionEnded')).toBeNull();
  });
});
