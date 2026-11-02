import {afterEach,describe,expect,it,vi} from 'vitest';
import {verifyDocumentDevelopment} from '../../scripts/verify-document-development.ts';

afterEach(()=>vi.unstubAllEnvs());
describe('remote document verification target guards',()=>{
 it('refuses production before importing application configuration or connecting anywhere',async()=>{
  vi.stubEnv('DATABASE_ENVIRONMENT','production');await expect(verifyDocumentDevelopment()).rejects.toThrow('DEVELOPMENT_ENVIRONMENT_REQUIRED');
 });
 it('refuses a production branch even when the environment is labelled development',async()=>{
  vi.stubEnv('DATABASE_ENVIRONMENT','development');vi.stubEnv('NEON_BRANCH','production');await expect(verifyDocumentDevelopment()).rejects.toThrow('EXPECTED_BRANCH_REQUIRED');
 });
 it('refuses another Neon database despite a correct branch label',async()=>{
  vi.stubEnv('DATABASE_ENVIRONMENT','development');vi.stubEnv('NEON_BRANCH','development');vi.stubEnv('DATABASE_URL','postgresql://synthetic:synthetic@ep-unapproved-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb');vi.stubEnv('DATABASE_URL_UNPOOLED','postgresql://synthetic:synthetic@ep-unapproved.c-4.ap-southeast-1.aws.neon.tech/neondb');
  await expect(verifyDocumentDevelopment()).rejects.toThrow('EXPECTED_DEVELOPMENT_DATABASE_REQUIRED');
 });
 it('refuses a mismatched object-storage branch before loading the application',async()=>{
  vi.stubEnv('DATABASE_ENVIRONMENT','development');vi.stubEnv('NEON_BRANCH','development');vi.stubEnv('DATABASE_URL','postgresql://synthetic:synthetic@ep-mute-smoke-b3oy0p7l-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb');vi.stubEnv('DATABASE_URL_UNPOOLED','postgresql://synthetic:synthetic@ep-mute-smoke-b3oy0p7l.c-4.ap-southeast-1.aws.neon.tech/neondb');vi.stubEnv('AWS_ENDPOINT_URL_S3','https://br-unapproved.storage.c-4.ap-southeast-1.aws.neon.tech');
  await expect(verifyDocumentDevelopment()).rejects.toThrow('EXPECTED_DEVELOPMENT_STORAGE_REQUIRED');
 });
});
