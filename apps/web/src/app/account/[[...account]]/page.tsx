import { AccountPage } from '@/components/account-page';
import { Suspense } from 'react';
import { AuthLoading } from '@/components/auth-context';

export default function Page() { return <Suspense fallback={<AuthLoading/>}><AccountPage/></Suspense>; }
