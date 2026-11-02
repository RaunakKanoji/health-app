import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import { expect, type Page } from '@playwright/test';

/** Real Clerk sessions against explicitly provisioned development identities. No application auth bypass. */
export async function login(page:Page,role:string){
 const emailAddress=process.env[`CLERK_E2E_${role.toUpperCase()}_EMAIL`];
 if(!emailAddress)throw new Error(`Missing configured development Clerk identity for ${role}.`);
 await setupClerkTestingToken({page});
 await page.goto('/sign-in');await clerk.loaded({page});
 const signedIn=await page.evaluate(()=>Boolean((window as unknown as {Clerk?:{user?:unknown}}).Clerk?.user));
 if(signedIn)await clerk.signOut({page});
 await page.goto('/sign-in',{waitUntil:'domcontentloaded'});await clerk.signIn({page,emailAddress});
 // The branded Clerk page performs the continuation itself. Starting a second
 // navigation here can abort its redirect while the session becomes active.
 await page.waitForURL(url=>url.pathname===(role==='admin'?'/admin':'/'));
 await expect.poll(async()=>{const response=await page.request.get('/api/identity');return response.ok()?(await response.json()).user?.id:null;}).toBe(`user-${role}`);
 await expect(page.locator(role==='patient'?'.patient-app':role==='admin'?'.identity-shell':'.sidebar')).toBeVisible();
}
