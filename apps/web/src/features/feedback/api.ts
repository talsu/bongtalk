import { apiRequest } from '../../lib/api';

export type FeedbackCategory = 'BUG' | 'FEATURE' | 'OTHER';

export function submitFeedback(args: {
  category: FeedbackCategory;
  content: string;
  workspaceId?: string | null;
}): Promise<{ id: string; createdAt: string }> {
  return apiRequest('/feedback', { method: 'POST', body: args });
}
