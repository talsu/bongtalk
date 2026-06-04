import type { MemberFullProfileView } from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';

/**
 * S75 (D14 / FR-PS-07·08 · Fork A-1): 타 멤버 전체 프로필 단일 엔드포인트 클라이언트.
 * 프로필 팝오버(미니카드)와 전체 프로필 패널(슬라이드인)이 같은 응답을 공유한다.
 * URL 은 워크스페이스 스코프 — 서버가 요청자/대상 멤버십을 검증한다(비멤버 404).
 */
export function fetchMemberFullProfile(
  workspaceId: string,
  userId: string,
): Promise<MemberFullProfileView> {
  return apiRequest(`/workspaces/${workspaceId}/members/${userId}/full-profile`);
}
