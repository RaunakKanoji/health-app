import { defineConfig,devices } from '@playwright/test';
const baseURL=process.env.PLAYWRIGHT_BASE_URL??'http://localhost:3001';
export default defineConfig({
 projects:[{name:'clerk-setup',testMatch:/clerk\.setup\.ts/},{name:'chromium',testMatch:/.*\.spec\.ts/,dependencies:['clerk-setup']}],
 testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:60000,
 expect:{timeout:10000},reporter:[['list'],['html',{open:'never'}]],
 use:{baseURL,trace:'retain-on-failure',screenshot:'only-on-failure',...devices['Desktop Chrome'],viewport:{width:1440,height:1000}},
 webServer:{command:'pnpm dev',url:`${baseURL}/api/health`,reuseExistingServer:!process.env.CI,timeout:120000},
});
