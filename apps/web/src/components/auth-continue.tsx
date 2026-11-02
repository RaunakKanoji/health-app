'use client';
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { authorizedReturnPath } from '@/lib/auth-routing';
import { AuthGate, AuthLoading, useIdentity } from './auth-context';

function ContinueDestination() {
  const {identity} = useIdentity();
  const search = useSearchParams();
  const router = useRouter();
  const destination = identity ? authorizedReturnPath(search.get('next'), identity.user, identity.destination) : null;
  useEffect(()=>{if(destination)router.replace(destination);},[destination,router]);
  return <AuthLoading/>;
}
export function AuthContinue() {return <AuthGate mode="continue"><ContinueDestination/></AuthGate>;}
