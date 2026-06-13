import { apiRequest } from '../../lib/api';
import type {
  Channel,
  ChannelListResponse,
  ListBrowsableChannelsResponse,
  ChannelPermissionOverride,
  ChannelPermissionOverrideListResponse,
  CreateCategoryRequest,
  CreateChannelRequest,
  Favorite,
  FavoritesResponse,
  MoveCategoryRequest,
  MoveChannelRequest,
  MoveFavoriteRequest,
  ReorderCategoriesRequest,
  ReorderChannelsRequest,
  UpdateChannelRequest,
  Category,
  CreateSidebarSectionRequest,
  MoveSidebarChannelRequest,
  MoveSidebarSectionRequest,
  SidebarSection,
  SidebarSectionsResponse,
  UpdateSidebarSectionRequest,
} from '@qufox/shared-types';

export function listChannels(wsId: string): Promise<ChannelListResponse> {
  return apiRequest(`/workspaces/${wsId}/channels`);
}

// 072 백로그 S-D (FR-CH-06): 채널 둘러보기 — 공개 채널 + memberCount + isMember.
export function listBrowsableChannels(wsId: string): Promise<ListBrowsableChannelsResponse> {
  return apiRequest(`/workspaces/${wsId}/channels/browse`);
}

export function createChannel(wsId: string, input: CreateChannelRequest): Promise<Channel> {
  return apiRequest(`/workspaces/${wsId}/channels`, { method: 'POST', body: input });
}

export function updateChannel(
  wsId: string,
  channelId: string,
  input: UpdateChannelRequest,
): Promise<Channel> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function deleteChannel(wsId: string, channelId: string): Promise<void> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}`, { method: 'DELETE' });
}

// S14 (FR-CH-07): 채널 가입(공개 채널 자유 가입; 비공개는 403). member_added 발행.
export function joinChannel(
  wsId: string,
  channelId: string,
): Promise<{ channelId: string; userId: string }> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/join`, { method: 'POST' });
}

// S14 (FR-CH-07): 채널 탈퇴. 읽기 상태(UserChannelReadState)는 서버가 보존한다.
export function leaveChannel(
  wsId: string,
  channelId: string,
): Promise<{ channelId: string; userId: string }> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/leave`, { method: 'POST' });
}

export function archiveChannel(wsId: string, channelId: string): Promise<Channel> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/archive`, { method: 'POST' });
}

export function unarchiveChannel(wsId: string, channelId: string): Promise<Channel> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/unarchive`, { method: 'POST' });
}

export function moveChannel(
  wsId: string,
  channelId: string,
  input: MoveChannelRequest,
): Promise<Channel> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/move`, {
    method: 'POST',
    body: input,
  });
}

export function createCategory(wsId: string, input: CreateCategoryRequest): Promise<Category> {
  return apiRequest(`/workspaces/${wsId}/categories`, { method: 'POST', body: input });
}

export function moveCategory(
  wsId: string,
  categoryId: string,
  input: MoveCategoryRequest,
): Promise<Category> {
  return apiRequest(`/workspaces/${wsId}/categories/${categoryId}/move`, {
    method: 'POST',
    body: input,
  });
}

// S15 (FR-CH-13): 채널 배치 재정렬. 서버가 1000 등간격으로 재정규화한 전체
// 채널 목록을 반환한다.
export function reorderChannels(
  wsId: string,
  input: ReorderChannelsRequest,
): Promise<{ channels: Channel[] }> {
  return apiRequest(`/workspaces/${wsId}/channels/positions`, {
    method: 'PATCH',
    body: input,
  });
}

// S15 (FR-CH-13): 카테고리 배치 재정렬.
export function reorderCategories(
  wsId: string,
  input: ReorderCategoriesRequest,
): Promise<{ categories: Category[] }> {
  return apiRequest(`/workspaces/${wsId}/categories/positions`, {
    method: 'PATCH',
    body: input,
  });
}

// S43 (FR-CH-15): 즐겨찾기 추가(멱등). 200 + 단일 Favorite.
export function addFavorite(wsId: string, channelId: string): Promise<Favorite> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/favorite`, { method: 'POST' });
}

// S43 (FR-CH-15): 즐겨찾기 해제. 204.
export function removeFavorite(wsId: string, channelId: string): Promise<void> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/favorite`, { method: 'DELETE' });
}

// S43 (FR-CH-15): 즐겨찾기 재정렬(드래그). fractional anchor(beforeId/afterId).
export function moveFavorite(
  wsId: string,
  channelId: string,
  input: MoveFavoriteRequest,
): Promise<Favorite> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/favorite/position`, {
    method: 'PATCH',
    body: input,
  });
}

// S43 (FR-CH-15): 전체 즐겨찾기 목록(개인 스코프).
export function listFavorites(): Promise<FavoritesResponse> {
  return apiRequest(`/me/favorites`);
}

// ── S85 (FR-CH-16): 사이드바 개인 섹션 ────────────────────────────────────────

// 워크스페이스 내 본인 섹션 목록(position asc · 각 섹션 channelIds 포함).
export function listSidebarSections(wsId: string): Promise<SidebarSectionsResponse> {
  return apiRequest(`/workspaces/${wsId}/sidebar-sections`);
}

// 섹션 생성(201 + 단일 SidebarSection).
export function createSidebarSection(
  wsId: string,
  input: CreateSidebarSectionRequest,
): Promise<SidebarSection> {
  return apiRequest(`/workspaces/${wsId}/sidebar-sections`, { method: 'POST', body: input });
}

// 섹션 이름/이모지/정렬방식 부분 갱신.
export function updateSidebarSection(
  wsId: string,
  sectionId: string,
  input: UpdateSidebarSectionRequest,
): Promise<SidebarSection> {
  return apiRequest(`/workspaces/${wsId}/sidebar-sections/${sectionId}`, {
    method: 'PATCH',
    body: input,
  });
}

// 섹션 삭제(204). 할당 채널은 사이드바 기본 위치로 복귀.
export function deleteSidebarSection(wsId: string, sectionId: string): Promise<void> {
  return apiRequest(`/workspaces/${wsId}/sidebar-sections/${sectionId}`, { method: 'DELETE' });
}

// 섹션 재정렬(드래그). fractional anchor(beforeId/afterId).
export function moveSidebarSection(
  wsId: string,
  sectionId: string,
  input: MoveSidebarSectionRequest,
): Promise<SidebarSection> {
  return apiRequest(`/workspaces/${wsId}/sidebar-sections/${sectionId}/position`, {
    method: 'PATCH',
    body: input,
  });
}

// 채널을 섹션에 할당(멱등). 200 + 갱신된 섹션.
export function assignSidebarChannel(
  wsId: string,
  sectionId: string,
  channelId: string,
): Promise<SidebarSection> {
  return apiRequest(`/workspaces/${wsId}/sidebar-sections/${sectionId}/channels`, {
    method: 'POST',
    body: { channelId },
  });
}

// 채널 할당 해제. 200 + 갱신된 섹션.
export function unassignSidebarChannel(
  wsId: string,
  sectionId: string,
  channelId: string,
): Promise<SidebarSection> {
  return apiRequest(`/workspaces/${wsId}/sidebar-sections/${sectionId}/channels/${channelId}`, {
    method: 'DELETE',
  });
}

// 섹션 내 채널 재정렬 + 섹션 간 이동(드래그). fractional anchor + sectionId.
export function moveSidebarChannel(
  wsId: string,
  channelId: string,
  input: MoveSidebarChannelRequest,
): Promise<SidebarSection> {
  return apiRequest(`/workspaces/${wsId}/sidebar-sections/channels/${channelId}/position`, {
    method: 'PATCH',
    body: input,
  });
}

// S43 (FR-CH-17): 채널 뮤트 설정. until=ISO(만료 시각) 또는 null(무기한).
export function setChannelMute(channelId: string, until: string | null): Promise<unknown> {
  return apiRequest(`/me/mutes/channels/${channelId}`, { method: 'POST', body: { until } });
}

// S43 (FR-CH-17): 채널 뮤트 해제. 204.
export function removeChannelMute(channelId: string): Promise<void> {
  return apiRequest(`/me/mutes/channels/${channelId}`, { method: 'DELETE' });
}

// S62 (FR-RM14): 채널 권한 오버라이드 목록 조회(OWNER/ADMIN). allow/denyMask 는
// string(BigInt-as-string · ADR-11) — 컴포넌트가 BigInt 로 파싱한다.
export function listChannelOverrides(
  wsId: string,
  channelId: string,
): Promise<ChannelPermissionOverrideListResponse> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/overrides`);
}

// S62 (FR-RM14): ROLE 프린시펄 오버라이드 upsert. allowMask/denyMask 는 집행
// 비트필드(number, ≤0x1FF) 요청값. 시스템 역할 리터럴 principal 만 지원(현재 백엔드).
export function upsertChannelRoleOverride(
  wsId: string,
  channelId: string,
  input: {
    role: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
    allowMask: number;
    denyMask: number;
  },
): Promise<{ override: ChannelPermissionOverride }> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/roles`, {
    method: 'POST',
    body: input,
  });
}

// S62 (FR-RM14): USER 프린시펄(멤버) 오버라이드 upsert.
export function upsertChannelMemberOverride(
  wsId: string,
  channelId: string,
  input: { userId: string; allowMask: number; denyMask: number },
): Promise<{ override: ChannelPermissionOverride }> {
  return apiRequest(`/workspaces/${wsId}/channels/${channelId}/members`, {
    method: 'POST',
    body: input,
  });
}
