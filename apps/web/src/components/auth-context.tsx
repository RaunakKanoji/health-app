'use client';
import { useAuth, useClerk } from '@clerk/nextjs';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useUiLanguage } from '@/lib/i18n';
import { ApiFailure, request, setSessionTokenGetter } from '@/lib/api';
import { Button, ErrorBanner, Logo, Spinner } from './shared';

export type { IdentityState as ApplicationIdentity } from '../../../../packages/contracts/src/identity';
import type { IdentityState as ApplicationIdentity } from '../../../../packages/contracts/src/identity';
type IdentityError = {message: string; code: string | null; status: number | null};
type IdentityContextValue = {
  identity: ApplicationIdentity | null;
  loading: boolean;
  signedIn: boolean;
  error: IdentityError | null;
  refresh: () => Promise<ApplicationIdentity | null>;
  signOut: () => Promise<void>;
};
const IdentityContext = createContext<IdentityContextValue | null>(null);
export function CareLoopAuthProvider({children}: {children: ReactNode}) {
  const {isLoaded, isSignedIn, userId, sessionId, getToken} = useAuth({treatPendingAsSignedOut: true});
  const {signOut: clerkSignOut} = useClerk();
  const [identity, setIdentity] = useState<ApplicationIdentity | null>(null);
  const [resolvedFor, setResolvedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<IdentityError | null>(null);
  const requestVersion = useRef(0);
  const identityRequest = useRef<AbortController | null>(null);
  const sessionKey = userId && sessionId ? `${userId}:${sessionId}` : null;
  const refresh = useCallback(async () => {
    if (!isLoaded || !isSignedIn || !sessionKey) return null;
    setSessionTokenGetter(() => getToken(), sessionKey);
    identityRequest.current?.abort();
    const controller = new AbortController();
    identityRequest.current = controller;
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const value = await request<ApplicationIdentity>('/identity', { signal: controller.signal });
      if (version !== requestVersion.current || controller.signal.aborted) return null;
      setIdentity(value);
      setResolvedFor(sessionKey);
      return value;
    } catch (failure) {
      if (version !== requestVersion.current || controller.signal.aborted) return null;
      setIdentity(null);
      setResolvedFor(null);
      setError({
        message: failure instanceof ApiFailure && failure.status === 401 ? 'Your session is no longer available. Sign out and sign in again.' : failure instanceof Error ? failure.message : 'Your account could not be loaded. Please retry.',
        code: failure instanceof ApiFailure ? failure.code : null,
        status: failure instanceof ApiFailure ? failure.status : null,
      });
      return null;
    } finally {
      if (identityRequest.current === controller) identityRequest.current = null;
      if (version === requestVersion.current && !controller.signal.aborted) setLoading(false);
    }
  }, [isLoaded, isSignedIn, sessionKey, getToken]);
  useEffect(() => {
    requestVersion.current++;
    identityRequest.current?.abort();
    identityRequest.current = null;
    setIdentity(null);
    setResolvedFor(null);
    setError(null);
    if (!isLoaded) return;
    if (!isSignedIn) {
      setSessionTokenGetter(null);
      setLoading(false);
      return;
    }
    setSessionTokenGetter(() => getToken(), sessionKey ?? undefined);
    void refresh();
    return () => { requestVersion.current++; identityRequest.current?.abort(); identityRequest.current = null; setSessionTokenGetter(null); };
  }, [isLoaded, isSignedIn, sessionKey, getToken, refresh]);
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => { if (event.persisted) {setIdentity(null);setResolvedFor(null);void refresh();} };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [refresh]);
  const signOut = useCallback(async () => {
    requestVersion.current++;
    identityRequest.current?.abort();
    identityRequest.current = null;
    setSessionTokenGetter(null);
    setIdentity(null);
    setResolvedFor(null);
    setLoading(true);
    try { await clerkSignOut({redirectUrl: '/sign-in'}); }
    catch { setLoading(false);setError({message:'Sign-out could not be confirmed. Please retry.',code:null,status:null}); }
  }, [clerkSignOut]);
  const validIdentity = isSignedIn && resolvedFor === sessionKey ? identity : null;
  return <IdentityContext.Provider value={{identity: validIdentity, loading: !isLoaded || loading, signedIn: Boolean(isSignedIn), error, refresh, signOut}}>{children}</IdentityContext.Provider>;
}
export function useIdentity() {
  const context = useContext(IdentityContext);
  if (!context) throw new Error('CareLoopAuthProvider is required.');
  return context;
}
export function AuthLoading() {
  const {t}=useUiLanguage();
  const [delayed,setDelayed]=useState(false);
  useEffect(()=>{const timer=setTimeout(()=>setDelayed(true),15000);return()=>clearTimeout(timer);},[]);
  return <div className="initial-loader" role="status"><Logo/><Spinner/><p>{t('Opening your secure workspace…')}</p>{delayed?<div className="auth-loading-delay"><p>{t('Secure access is taking longer than expected. Check your connection and retry.')}</p><Button variant="outline" onClick={()=>window.location.reload()}>{t('Try again')}</Button></div>:null}</div>;
}
export function AuthGate({children, mode = 'workspace'}: {children: ReactNode; mode?: 'workspace' | 'onboarding' | 'admin' | 'account' | 'continue'}) {
  const {t}=useUiLanguage();
  const {identity, loading, signedIn, error, refresh, signOut} = useIdentity();
  const router = useRouter();
  const pathname = usePathname();
  let destination: string | null = null;
  if (!loading && !signedIn) destination = `/sign-in?next=${encodeURIComponent(pathname === '/' || pathname === '/admin' || pathname === '/account' ? pathname : '/onboarding')}`;
  if (identity) {
    if (mode === 'workspace' && identity.destination !== '/') destination = identity.destination;
    if (mode === 'admin' && identity.user.role !== 'admin') destination = identity.destination;
    if (mode === 'onboarding') {
      if (identity.onboarding.status === 'complete') destination = identity.destination;
      else if (identity.onboarding.kind === 'clinician' && ['pending', 'rejected'].includes(identity.onboarding.status) && pathname !== '/onboarding/clinician/pending') destination = '/onboarding/clinician/pending';
      else if (pathname === '/onboarding/clinician/pending' && identity.onboarding.kind !== 'clinician') destination = identity.destination;
    }
  }
  useEffect(() => { if (destination && destination !== pathname) router.replace(destination); }, [destination, pathname, router]);
  if (loading || destination || (!identity && !error)) return <AuthLoading/>;
  if (error?.code === 'IDENTITY_LINK_REQUIRED' && error.status === 409) {
    return <main className="auth-message">
      <Logo/>
      <h1>{t('Account linking required')}</h1>
      <p role="alert">{t('You are signed in. Ask a CareLoop administrator to link your sign-in to your existing account before continuing.')}</p>
      <p>{t('No records have been linked automatically.')}</p>
      <div className="auth-actions">
        <Button variant="outline" onClick={()=>void signOut()}>{t('Sign out')}</Button>
        <Button onClick={()=>void refresh()}>{t('Check access after linking')}</Button>
      </div>
    </main>;
  }
  if (error) return <main className="auth-message"><Logo/><h1>{t('We couldn’t open your account')}</h1><ErrorBanner message={error.message} onRetry={()=>void refresh()}/><div className="auth-actions"><Button variant="outline" onClick={()=>void signOut()}>{t('Sign out')}</Button><Link href="/sign-in">{t('Return to sign in')}</Link></div></main>;
  return <>{children}</>;
}
