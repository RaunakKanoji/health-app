import { Login } from '@/components/login';
import { Suspense } from 'react';
import { AuthLoading } from '@/components/auth-context';

export default function Page() { return <Suspense fallback={<AuthLoading/>}><Login mode="sign-up"/></Suspense>; }
