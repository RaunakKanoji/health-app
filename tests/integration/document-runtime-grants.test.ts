import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {testApplication} from '../helpers.ts';
import {transactionDatabase} from '../../packages/db/src/index.ts';
import {DocumentManagementService} from '../../packages/workflows/src/documents/service.ts';
import {processDocumentJobs} from '../../packages/workflows/src/documents/processing.ts';
import {createDocumentExtractor} from '../../packages/workflows/src/documents/extraction.ts';
import {createDocumentScanner} from '../../packages/workflows/src/documents/scanner.ts';
import {syntheticDocumentFixtures} from '../../packages/workflows/src/documents/synthetic-fixtures.ts';
import type {DocumentStorage} from '../../packages/workflows/src/documents/storage.ts';
import {runtimeInsertTables,runtimeUpdateTables} from '../../scripts/provision-runtime-database.ts';

const identifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
class RollbackRoleFixture extends Error{}

describe('document operations under the restricted PostgreSQL runtime role',()=>{
 let ctx:Awaited<ReturnType<typeof testApplication>>;
 beforeAll(async()=>{ctx=await testApplication();});
 afterAll(async()=>{await ctx?.close();});
 it('permits the complete review workflow and exact row locks while denying deletion, immutable writes and DDL',async()=>{
  const role=`careloop_test_runtime_${randomUUID().replaceAll('-','')}`;
  const actor=(await ctx.app.service.user('user-patient'))!,clinician=(await ctx.app.service.user('user-clinician'))!;
  const capability=(await ctx.app.db.pool.query('SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
  if(!capability.rolsuper&&!capability.rolcreaterole)throw new Error('This local runtime-grant regression requires a test database owner with CREATEROLE. No production connection is permitted.');
  const objects=new Map<string,Uint8Array>();
  const storage:DocumentStorage={provider:'isolated-role-test',bucket:'synthetic',async createUploadUrl({key}){return {url:`https://fixture.invalid/${encodeURIComponent(key)}`};},async getObjectMetadata(key){return {size:objects.get(key)!.byteLength,mimeType:'application/pdf'};},async getObjectBytes(key){return objects.get(key)!;},async put({key,body}){objects.set(key,new Uint8Array(body));},async createDownloadUrl(){return 'https://fixture.invalid/signed';},async deleteObject(key){objects.delete(key);}};
  try{
   await ctx.app.db.transaction(async tx=>{
    await tx.query(`CREATE ROLE ${identifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    const owner=(await tx.query<{owner:string}>('SELECT current_user AS owner')).rows[0]!.owner;
    await tx.query(`GRANT ${identifier(role)} TO ${identifier(owner)}`);
    await tx.query(`GRANT USAGE ON SCHEMA ${identifier(ctx.schema)} TO ${identifier(role)}`);
    await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${identifier(ctx.schema)} TO ${identifier(role)}`);
    const tables=(names:readonly string[])=>names.map(name=>`${identifier(ctx.schema)}.${identifier(name)}`).join(',');
    await tx.query(`GRANT INSERT ON TABLE ${tables(runtimeInsertTables)} TO ${identifier(role)}`);
    await tx.query(`GRANT UPDATE ON TABLE ${tables(runtimeUpdateTables)} TO ${identifier(role)}`);
    await tx.query(`GRANT UPDATE(id) ON ${identifier(ctx.schema)}.clinical_notes TO ${identifier(role)}`);
    await tx.query(`GRANT DELETE ON ${identifier(ctx.schema)}.role_assignments TO ${identifier(role)}`);
    await tx.query(`SET LOCAL ROLE ${identifier(role)}`);
    expect((await tx.query('SELECT current_user AS role')).rows[0].role).toBe(role);
    const privileges=(await tx.query("SELECT has_schema_privilege(current_user,current_schema(),'CREATE') AS schema_create,has_database_privilege(current_user,current_database(),'CREATE') AS database_create,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    expect(Object.values(privileges).every(value=>value===false)).toBe(true);

    const db=transactionDatabase(tx),service=new DocumentManagementService(db,storage),fixture=syntheticDocumentFixtures.hba1c;
    const session=await service.initialize(actor,'patient-001',{title:'Synthetic restricted-role verification',filename:fixture.filename,mimeType:fixture.mimeType,fileSize:fixture.bytes.byteLength,checksumSha256:fixture.sha256,documentType:'laboratory_report'},randomUUID());
    objects.set(decodeURIComponent(new URL(session.uploadUrl).pathname.slice(1)),fixture.bytes);
    const {document}=await service.complete(actor,'patient-001',session.sessionId,randomUUID());
    const processed=await processDocumentJobs(db,{documentIds:[document.id],storageFor:()=>storage,scanner:createDocumentScanner({DOCUMENT_SYNTHETIC_FIXTURES:'true',DEMO_MODE:'true',DATABASE_ENVIRONMENT:'test'}),extractor:createDocumentExtractor({DOCUMENT_EXTERNAL_PROCESSING_ALLOWED:'false'})});
    expect(processed).toMatchObject({claimed:1,completed:1});
    const detail=await service.detail(clinician,'patient-001',document.id),observation=detail.observations[0]!;
    expect(detail.document.securityStatus).toBe('safe');expect(observation.originalValue).toBe('5.2000');
    await service.correct(clinician,'patient-001',document.id,observation.id,{verificationStatus:'verified',reason:'Compared with the exact synthetic source under restricted role'},randomUUID());
    await service.review(clinician,'patient-001',document.id,{versionId:document.currentVersionId!,status:'approved',reviewNotes:'Synthetic source reviewed by the authorized fixture clinician'},randomUUID());
    expect((await service.observations(actor,'patient-001')).observations.some(item=>item.id===observation.id)).toBe(true);
    expect((await service.file(actor,'patient-001',document.id)).expiresIn).toBe(60);
    await service.remove(actor,'patient-001',document.id,'Synthetic deletion under the restricted runtime role',randomUUID());
    expect((await service.list(actor,'patient-001')).documents.some(item=>item.id===document.id)).toBe(false);
    await service.restore(actor,'patient-001',document.id,randomUUID());
    expect((await service.detail(actor,'patient-001',document.id)).document.deletedAt).toBeNull();

    // Permission errors abort a PG transaction; each denial gets its own savepoint.
    async function denied(sql:string,values:unknown[]=[]){
     await tx.query('SAVEPOINT expected_permission_denial');
     try{await expect(tx.query(sql,values)).rejects.toMatchObject({code:'42501'});}
     finally{await tx.query('ROLLBACK TO SAVEPOINT expected_permission_denial');await tx.query('RELEASE SAVEPOINT expected_permission_denial');}
    }
    await denied('DELETE FROM medical_documents WHERE id=$1',[document.id]);
    await denied('DELETE FROM document_processing_jobs WHERE document_id=$1',[document.id]);
    await denied('UPDATE document_versions SET change_reason=$1 WHERE id=$2',['forbidden',document.currentVersionId]);
    await denied("UPDATE document_security_checks SET verdict='infected' WHERE document_id=$1",[document.id]);
    await denied(`CREATE TABLE ${identifier(ctx.schema)}.forbidden_runtime_table(id integer)`);
    await denied('ALTER TABLE medical_documents ADD COLUMN forbidden_runtime_column text');
    // Roll back role creation, membership, grants, and every synthetic document row together.
    throw new RollbackRoleFixture();
   });
  }catch(error){if(!(error instanceof RollbackRoleFixture))throw error;}
  expect((await ctx.app.db.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount).toBe(0);
 });
});
