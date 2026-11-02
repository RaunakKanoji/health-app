import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { safeReturnPath } from '@/lib/auth-routing';

const isPublicPage = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)']);
export default clerkMiddleware(async (auth, request) => {
  // Fastify independently verifies every API session and returns JSON 401/403 responses.
  if (request.nextUrl.pathname.startsWith('/api/') || isPublicPage(request)) return;
  const {isAuthenticated} = await auth();
  if (!isAuthenticated) {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('next', safeReturnPath(request.nextUrl.pathname) ?? '/');
    return NextResponse.redirect(signIn);
  }
});
export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
