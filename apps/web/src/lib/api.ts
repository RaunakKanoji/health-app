import type { ApiError, Command, Episode, Workspace, User, AssistantResponse } from '../../../../packages/contracts/src/careloop.ts';
export type { Command, Episode, Workspace, User, AssistantResponse };

export class ApiFailure extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); this.name = 'ApiFailure'; }
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json().catch(() => null) as T | ApiError | null;
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result ? (result as ApiError).error : null;
    throw new ApiFailure(error?.message ?? 'The service could not complete this request. Please try again.', response.status, error?.code ?? 'REQUEST_FAILED');
  }
  return result as T;
}
export const api = {
  workspace: () => request<Workspace>('/workspace'),
  login: (email: string, password: string) => request<{user: User}>('/auth/login', { method: 'POST', body: JSON.stringify({email,password}) }),
  logout: () => request('/auth/logout', {method:'POST', body:'{}'}),
  command: (id: string, command: Command, key = crypto.randomUUID()) => request<{episode: Episode}>(`/episodes/${id}/actions`, { method: 'POST', headers: {'Idempotency-Key': key}, body: JSON.stringify(command) }),
  assistant: (id: string, question: string) => request<AssistantResponse>(`/episodes/${id}/assistant`, {method:'POST',body:JSON.stringify({question})}),
};
