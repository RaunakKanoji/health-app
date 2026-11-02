'use client';
import { useUiLanguage } from '@/lib/i18n';
import Link from 'next/link';
import { UserProfile } from '@clerk/nextjs';
import { AuthGate, useIdentity } from './auth-context';
import { IdentityShell } from './identity-shell';

export function AccountPage() {
  const {t}=useUiLanguage();
  const {identity} = useIdentity();
  return <AuthGate mode="account"><IdentityShell title="Your account" description="Manage your identity, sign-in methods and active sessions. Clinical access is governed separately by CareLoop."><Link className="text-link account-return" href={identity?.destination??'/auth/continue'}>{t("Return to your workspace")}</Link><div className="account-profile"><UserProfile routing="path" path="/account"/></div></IdentityShell></AuthGate>;
}
