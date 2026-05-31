import { apiRequest } from '../../lib/api';
import type {
  Channel,
  ChannelListResponse,
  CreateCategoryRequest,
  CreateChannelRequest,
  MoveCategoryRequest,
  MoveChannelRequest,
  UpdateChannelRequest,
  Category,
} from '@qufox/shared-types';

export function listChannels(wsId: string): Promise<ChannelListResponse> {
  return apiRequest(`/workspaces/${wsId}/channels`);
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
