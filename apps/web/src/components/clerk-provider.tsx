'use client';
import { ClerkProvider } from '@clerk/nextjs';
import { enUS } from '@clerk/localizations/en-US';
import { hiIN } from '@clerk/localizations/hi-IN';
import { ui } from '@clerk/ui';
import { shadcn } from '@clerk/ui/themes';
import type { ReactNode } from 'react';
import { useUiLanguage } from '@/lib/i18n';
import { CareLoopAuthProvider } from './auth-context';

export function LocalizedClerkProvider({children}: {children:ReactNode}) {
  const {language} = useUiLanguage();
  return <ClerkProvider
    ui={ui}
    signInUrl="/sign-in"
    signUpUrl="/sign-up"
    signInForceRedirectUrl="/auth/continue"
    signUpForceRedirectUrl="/auth/continue"
    afterSignOutUrl="/sign-in"
    localization={language==='hi'?hiIN:enUS}
    appearance={{theme:shadcn,variables:{colorPrimary:'#197566',colorForeground:'#203c38',colorBackground:'#ffffff',borderRadius:'0.75rem',fontFamily:'Arial, Helvetica, sans-serif'}}}
  ><CareLoopAuthProvider>{children}</CareLoopAuthProvider></ClerkProvider>;
}
