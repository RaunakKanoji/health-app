import { defineConfig,devices } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:60000,
 expect:{timeout:10000},reporter:[['list'],['html',{open:'never'}]],
 use:{baseURL:'http://localhost:3000',trace:'retain-on-failure',screenshot:'only-on-failure',...devices['Desktop Chrome'],viewport:{width:1440,height:1000}},
 webServer:{command:'pnpm dev',url:'http://localhost:3000/api/health',reuseExistingServer:!process.env.CI,timeout:120000},
});
