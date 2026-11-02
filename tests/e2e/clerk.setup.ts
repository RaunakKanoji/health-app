import { clerkSetup } from '@clerk/testing/playwright';
import { test as setup } from '@playwright/test';

setup('initialize development Clerk testing',async()=>{
 const publishable=process.env.CLERK_PUBLISHABLE_KEY??process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
 if(!publishable?.startsWith('pk_test_')||!process.env.CLERK_SECRET_KEY?.startsWith('sk_test_'))throw new Error('Playwright authentication requires explicitly supplied development Clerk keys. Production keys are not permitted.');
 process.env.CLERK_PUBLISHABLE_KEY=publishable;
 await clerkSetup();
});
