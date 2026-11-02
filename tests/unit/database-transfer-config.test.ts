import { describe, expect, it } from 'vitest';
import { destinationConfiguration, sourceConfiguration } from '../../scripts/migrate-local-to-neon.ts';
import type { CareLoopConfig } from '../../packages/config/src/index.ts';

const config=(overrides:Partial<CareLoopConfig>={}):CareLoopConfig=>({
 DEMO_MODE:'true',DATABASE_ENVIRONMENT:'development',
 DATABASE_URL:'postgresql://fixture:fixture@ep-fixture-pooler.us-east-2.aws.neon.tech/neondb?sslmode=verify-full',
 DATABASE_DIRECT_URL:'postgresql://fixture:fixture@ep-fixture.us-east-2.aws.neon.tech/neondb?sslmode=verify-full',
 APP_ORIGIN:'http://localhost:3001',API_PORT:4001,DATA_RETENTION_DAYS:365,DEFAULT_ORGANIZATION_ID:'org-screening',...overrides,
});
describe('local-preview to Neon transfer guards',()=>{
 it('accepts only an explicitly selected local preview schema',()=>{
  const url=new URL('postgresql://fixture:fixture@127.0.0.1:54329/careloop');
  url.searchParams.set('options','-c search_path=careloop_preview_0123456789abcdef0123456789abcdef');
  expect(sourceConfiguration(url.href).schema).toBe('careloop_preview_0123456789abcdef0123456789abcdef');
  expect(()=>sourceConfiguration(undefined)).toThrow();
  expect(()=>sourceConfiguration('postgresql://fixture:fixture@127.0.0.1:54329/careloop')).toThrow();
  url.searchParams.set('options','-c search_path=public');expect(()=>sourceConfiguration(url.href)).toThrow();
  url.searchParams.set('options','-c search_path=careloop_preview_0123456789abcdef0123456789abcdef');url.hostname='remote.example';url.searchParams.set('sslmode','verify-full');
  expect(()=>sourceConfiguration(url.href)).toThrow();
 });
 it('requires explicit production initialization and matching direct Neon target',()=>{
  expect(destinationConfiguration(config(),false)).toContain('ep-fixture.');
  expect(()=>destinationConfiguration(config({DATABASE_ENVIRONMENT:'production'}),false)).toThrow();
  expect(destinationConfiguration(config({DATABASE_ENVIRONMENT:'production'}),true)).toContain('ep-fixture.');
  expect(()=>destinationConfiguration(config({DATABASE_ENVIRONMENT:'staging'}),true)).toThrow();
  expect(()=>destinationConfiguration(config({DATABASE_DIRECT_URL:undefined}),false)).toThrow();
  expect(()=>destinationConfiguration(config({DATABASE_DIRECT_URL:'postgresql://fixture:fixture@ep-other.us-east-2.aws.neon.tech/neondb?sslmode=verify-full'}),false)).toThrow();
  expect(()=>destinationConfiguration(config({DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:54329/careloop',DATABASE_DIRECT_URL:'postgresql://fixture:fixture@127.0.0.1:54329/careloop'}),false)).toThrow();
 });
});
