import type { User } from './api';

const applicationPaths = new Set(['/', '/account', '/admin', '/onboarding', '/onboarding/patient', '/onboarding/clinician', '/onboarding/clinician/pending']);
/** Deliberately accept only application-owned paths, without queries or fragments. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  return applicationPaths.has(value) ? value : null;
}
export function authorizedReturnPath(value: string | null, user: User, destination: string): string {
  const path = safeReturnPath(value);
  if (!path) return destination;
  if (path === '/account') return path;
  if (destination !== '/' && destination !== '/admin') return destination;
  if (path === '/admin') return user.role === 'admin' ? path : destination;
  if (path === '/') return user.role === 'admin' ? '/admin' : path;
  return destination;
}
