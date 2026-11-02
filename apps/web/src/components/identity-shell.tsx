'use client';
import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { Globe2, LogOut, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useUiLanguage } from '@/lib/i18n';
import { useIdentity } from './auth-context';
import { Logo } from './shared';

export function AccountControl() {
  const {t}=useUiLanguage();
  return <span className="account-control"><UserButton userProfileMode="navigation" userProfileUrl="/account"/><Link href="/account">{t('Account')}</Link></span>;
}
export function IdentityShell({title, description, children}: {title: string; description: string; children: ReactNode}) {
  const {language, setLanguage, t} = useUiLanguage();
  const {signOut, identity} = useIdentity();
  return <div className="identity-shell" lang={language}>
    <header className="identity-header"><Link href={identity?.destination ?? '/'} aria-label="CareLoop home"><Logo/></Link><div className="auth-actions"><button type="button" className="language-toggle" onClick={()=>setLanguage(language==='en'?'hi':'en')}><Globe2 size={16}/>{language==='en'?'हिन्दी':'English'}</button><AccountControl/><button type="button" className="icon-button" aria-label={t('Sign out')} onClick={()=>void signOut()}><LogOut size={18}/></button></div></header>
    <main className="identity-content"><header className="page-title"><div><span className="eyebrow">{t('YOUR CARE COORDINATION WORKSPACE')}</span><h1>{t(title)}</h1><p>{t(description)}</p></div></header>{children}</main>
    <footer className="patient-footer"><ShieldCheck size={15}/>{t('Synthetic demonstration · Not for clinical use')}</footer>
  </div>;
}
