import type { Metadata } from 'next';
import { LocalizedClerkProvider } from '@/components/clerk-provider';
import { LanguageProvider } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'CareLoop · Every result, a next step',
  description: 'A synthetic, clinician-governed screening-to-care coordination demonstration.',
};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  // Browser hosts may inject root styles before hydration; keep this exception on html only.
  return <html lang="en" suppressHydrationWarning><body><LanguageProvider><LocalizedClerkProvider>{children}</LocalizedClerkProvider></LanguageProvider></body></html>;
}
