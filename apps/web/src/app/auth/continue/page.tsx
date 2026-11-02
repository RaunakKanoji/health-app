import { AuthContinue } from '@/components/auth-continue';
import { Suspense } from 'react';
import { AuthLoading } from '@/components/auth-context';

export default function Page() { return <Suspense fallback={<AuthLoading/>}><AuthContinue/></Suspense>; }
