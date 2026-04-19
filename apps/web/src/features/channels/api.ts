import { apiRequest } from '../../lib/api';
import type {
  Channel,
  ChannelListResponse,
  CreateCategoryRequest,
  CreateChannelRequest,
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
