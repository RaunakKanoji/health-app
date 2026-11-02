import type { ApiError, Command, Episode, Workspace, User, AssistantResponse } from '../../../../packages/contracts/src/careloop.ts';
export type { Command, Episode, Workspace, User, AssistantResponse };

export class ApiFailure extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); this.name = 'ApiFailure'; }
}
let sessionTokenGetter: (() => Promise<string | null>) | null = null;
let sessionEpoch = 0;
export function setSessionTokenGetter(getter: (() => Promise<string | null>) | null) { sessionTokenGetter = getter; sessionEpoch++; }
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const epoch = sessionEpoch;
  const token = await sessionTokenGetter?.();
  if (!token || epoch !== sessionEpoch) throw new ApiFailure('Sign in to continue.', 401, 'UNAUTHENTICATED');
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}` } });
  const result = await response.json().catch(() => null) as T | ApiError | null;
  if (epoch !== sessionEpoch) throw new ApiFailure('Your session changed. Sign in again.', 401, 'SESSION_CHANGED');
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result ? (result as ApiError).error : null;
    throw new ApiFailure(error?.message ?? 'The service could not complete this request. Please try again.', response.status, error?.code ?? 'REQUEST_FAILED');
  }
  return result as T;
}
export const api = {
  workspace: () => request<Workspace>('/workspace'),
  command: (id: string, command: Command, key = crypto.randomUUID()) => request<{episode: Episode}>(`/episodes/${id}/actions`, { method: 'POST', headers: {'Idempotency-Key': key}, body: JSON.stringify(command) }),
  assistant: (id: string, question: string) => request<AssistantResponse>(`/episodes/${id}/assistant`, {method:'POST',body:JSON.stringify({question})}),
};
