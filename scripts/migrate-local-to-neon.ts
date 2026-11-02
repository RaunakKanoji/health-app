import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import { createDatabase, migrate, migrationFiles, transactionDatabase, type Db } from '../packages/db/src/index.ts';
import { databaseEndpoint, isLocalDatabase, readConfig, validateDatabaseSettings, type CareLoopConfig } from '../packages/config/src/index.ts';

type Queryable=Pick<PoolClient,'query'>;
type Link={table_name:string;referenced_table:string;columns:string[];referenced_columns:string[]};
type SnapshotTable={name:string;columns:string[];rows:string[];digest:string;dependencies:string[];selfLinks:Link[]};
type SequenceState={table:string;column:string;nextValue:string};
type Snapshot={tables:SnapshotTable[];sequences:SequenceState[];migrations:{name:string;sha256:string}[]};
const identifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
const qualified=(schema:string,table:string)=>`${identifier(schema)}.${identifier(table)}`;
const digest=(rows:string[])=>createHash('sha256').update([...rows].sort().join('\n')).digest('hex');
function refuse(message:string):never{throw new Error(message);}

/** Only a selected local preview schema may be a source; shared public data is excluded. */
export function sourceConfiguration(value:string|undefined):{url:string;schema:string}{
 if(!value)refuse('SOURCE_DATABASE_URL is required.');
 const url=databaseEndpoint(value);
 if(!isLocalDatabase(url))refuse('The transfer source must be local PostgreSQL.');
 const match=/^-c search_path=(careloop_preview_[a-f0-9]{32})$/.exec(url.searchParams.get('options')??'');
 if(!match)refuse('The source must explicitly select one CareLoop preview schema.');
 return {url:url.href,schema:match[1]!};
}

export function destinationConfiguration(config:CareLoopConfig,allowEmptyProduction:boolean):string{
 validateDatabaseSettings(config);
 if(config.DATABASE_ENVIRONMENT!=='development'&&!(config.DATABASE_ENVIRONMENT==='production'&&allowEmptyProduction))refuse('The selected environment requires explicit empty-production initialization permission.');
 const direct=config.DATABASE_DIRECT_URL??config.DATABASE_URL_UNPOOLED;
 if(!direct)refuse('The transfer requires the selected Neon direct connection.');
 const url=databaseEndpoint(direct);
 if(!url.hostname.endsWith('.neon.tech')||url.hostname.includes('-pooler.'))refuse('The destination must be a direct Neon endpoint.');
 if(url.searchParams.has('options')&&url.searchParams.get('options')!=='-c search_path=public')refuse('The destination must use its public application schema.');
 return url.href;
}

async function tablesIn(db:Queryable,schema:string):Promise<string[]>{
 return (await db.query<{name:string}>("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname",[schema])).rows.map(row=>row.name);
}
async function checkMigrationPrefix(db:Queryable,schema:string,allowEmpty=false){
 const tables=await tablesIn(db,schema);
 if(!tables.includes('schema_migrations')){if(allowEmpty&&tables.length===0)return [];refuse('The migration ledger is missing.');}
 const applied=(await db.query<{name:string;sha256:string}>(`SELECT name,sha256 FROM ${qualified(schema,'schema_migrations')} ORDER BY name`)).rows;
 const files=await migrationFiles();
 if(applied.length>files.length||(!allowEmpty&&applied.length<5))refuse('The source migration history is not a supported application schema.');
 for(let i=0;i<applied.length;i++)if(applied[i]!.name!==files[i]!.name||applied[i]!.sha256!==files[i]!.sha256)refuse('Migration history does not match the checked-in prefix.');
 return applied;
}

function orderedTables(tables:SnapshotTable[]):SnapshotTable[]{
 const pending=new Map(tables.map(table=>[table.name,table]));const done=new Set<string>();const ordered:SnapshotTable[]=[];
 while(pending.size){
  const ready=[...pending.values()].filter(table=>table.dependencies.every(name=>done.has(name)));
  if(!ready.length)refuse('The source has unsupported cyclic table dependencies.');
  for(const table of ready){pending.delete(table.name);done.add(table.name);ordered.push(table);}
 }
 return ordered;
}

function orderedRows(table:SnapshotTable):string[]{
 if(!table.selfLinks.length)return table.rows;
 // Parse only identifiers for dependency ordering. Insert the untouched JSON text so
 // PostgreSQL numeric precision and timestamps never pass through JavaScript numbers.
 const rows=table.rows.map(payload=>({payload,keys:JSON.parse(payload) as Record<string,unknown>}));
 const remaining=new Set(rows);const ordered:string[]=[];
 while(remaining.size){
  const ready=[...remaining].filter(row=>table.selfLinks.every(link=>{
   const values=link.columns.map(column=>row.keys[column]);if(values.some(value=>value===null))return true;
   return ![...remaining].some(parent=>parent!==row&&link.referenced_columns.every((column,index)=>parent.keys[column]===values[index]));
  }));
  if(!ready.length)refuse('The source has cyclic revision dependencies.');
  for(const row of ready){remaining.delete(row);ordered.push(row.payload);}
 }
 return ordered;
}

async function snapshot(db:Queryable,schema:string):Promise<Snapshot>{
 const migrations=await checkMigrationPrefix(db,schema);
 const files=(await migrationFiles()).slice(0,migrations.length);
 const expected=new Set(files.flatMap(file=>[...file.sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/g)].map(match=>match[1]!)));
 const names=(await tablesIn(db,schema)).filter(name=>name!=='schema_migrations');
 if(names.length!==expected.size||names.some(name=>!expected.has(name)))refuse('The source contains unexpected or missing application tables.');
 const links=(await db.query<Link>(`SELECT child.relname AS table_name,parent.relname AS referenced_table,
 array_agg(ca.attname ORDER BY key.ord) AS columns,array_agg(pa.attname ORDER BY key.ord) AS referenced_columns
 FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
 JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
 CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS key(child_num,parent_num,ord)
 JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=key.child_num
 JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=key.parent_num
 WHERE c.contype='f' AND cn.nspname=$1 AND pn.nspname=$1 GROUP BY c.oid,child.relname,parent.relname`,[schema])).rows;
 const tables:SnapshotTable[]=[];const sequences:SequenceState[]=[];
 for(const name of names){
  const columns=(await db.query<{name:string}>("SELECT a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum",[schema,name])).rows.map(row=>row.name);
  const rows=(await db.query<{payload:string}>(`SELECT to_jsonb(row_data)::text AS payload FROM (SELECT ${columns.map(identifier).join(',')} FROM ${qualified(schema,name)}) row_data`)).rows.map(row=>row.payload);
  const ownLinks=links.filter(link=>link.table_name===name);
  tables.push({name,columns,rows,digest:digest(rows),dependencies:[...new Set(ownLinks.filter(link=>link.referenced_table!==name).map(link=>link.referenced_table))],selfLinks:ownLinks.filter(link=>link.referenced_table===name)});
  for(const column of columns){
   const sequence=(await db.query<{schema:string;name:string}>("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_get_serial_sequence($1,$2)::regclass",[qualified(schema,name),column])).rows[0];
   if(!sequence)continue;
   if(sequence.schema!==schema)refuse('A source sequence is outside the selected preview schema.');
   const state=(await db.query<{last_value:string;is_called:boolean}>(`SELECT last_value::text,is_called FROM ${qualified(sequence.schema,sequence.name)}`)).rows[0]!;
   const maximum=(await db.query<{maximum:string}>(`SELECT COALESCE(max(${identifier(column)}),0)::text AS maximum FROM ${qualified(schema,name)}`)).rows[0]!.maximum;
   const sequenceNext=BigInt(state.last_value)+(state.is_called?1n:0n),recordNext=BigInt(maximum)+1n;
   sequences.push({table:name,column,nextValue:(sequenceNext>recordNext?sequenceNext:recordNext).toString()});
  }
 }
 return {tables:orderedTables(tables),sequences,migrations};
}

async function requireEmptyDestination(db:Queryable,lock:boolean){
 const files=await migrationFiles();const expected=new Set(files.flatMap(file=>[...file.sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/g)].map(match=>match[1]!)));
 const names=await tablesIn(db,'public');
 for(const name of names){
  if(name!=='schema_migrations'&&!expected.has(name))refuse('The destination has an unrelated table; initialization was refused.');
  if(lock)await db.query(`LOCK TABLE ${qualified('public',name)} IN ACCESS EXCLUSIVE MODE`);
  if(name==='schema_migrations')continue;
  if((await db.query(`SELECT 1 FROM ${qualified('public',name)} LIMIT 1`)).rowCount)refuse('The destination contains application records; no overwrite is permitted.');
 }
 await checkMigrationPrefix(db,'public',true);
}

/** Called only after the source read-only snapshot and empty-target guards have passed. */
async function applySnapshot(tx:PoolClient,data:Snapshot){
 await migrate(transactionDatabase(tx));
 await requireEmptyDestination(tx,true);
 for(const table of data.tables){
  const columns=table.columns.map(identifier).join(',');
  const rows=orderedRows(table),batchSize=table.selfLinks.length?1:100;
  for(let offset=0;offset<rows.length;offset+=batchSize){
   const payload=`[${rows.slice(offset,offset+batchSize).join(',')}]`;
   await tx.query(`INSERT INTO ${qualified('public',table.name)}(${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM jsonb_populate_recordset(NULL::${qualified('public',table.name)},$1::jsonb)`,[payload]);
  }
 }
 for(const table of data.tables){
  const rows=(await tx.query<{payload:string}>(`SELECT to_jsonb(row_data)::text AS payload FROM (SELECT ${table.columns.map(identifier).join(',')} FROM ${qualified('public',table.name)}) row_data`)).rows.map(row=>row.payload);
  if(rows.length!==table.rows.length||digest(rows)!==table.digest)refuse('Copied record verification failed; the destination transaction will roll back.');
 }
 const copied=new Set(data.tables.map(table=>table.name));
 for(const name of await tablesIn(tx,'public'))if(name!=='schema_migrations'&&!copied.has(name)&&(await tx.query(`SELECT 1 FROM ${qualified('public',name)} LIMIT 1`)).rowCount)refuse('Unexpected records appeared during initialization.');
 for(const sequence of data.sequences){
  const target=(await tx.query<{schema:string;name:string}>("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_get_serial_sequence($1,$2)::regclass",[qualified('public',sequence.table),sequence.column])).rows[0];
  if(!target||target.schema!=='public'||!/^\d+$/.test(sequence.nextValue))refuse('Destination sequence verification failed.');
  // RESTART is transactional, unlike setval(). A failed transfer cannot advance
  // a pre-existing empty destination's sequence outside its rollback boundary.
  await tx.query(`ALTER SEQUENCE ${qualified(target.schema,target.name)} RESTART WITH ${sequence.nextValue}`);
 }
}

export async function transferLocalToNeon(options:{sourceUrl:string|undefined;config:CareLoopConfig;apply:boolean;allowEmptyProduction:boolean}){
 const source=sourceConfiguration(options.sourceUrl),destination=destinationConfiguration(options.config,options.allowEmptyProduction);
 const sourceDb=createDatabase(source.url,{max:1});let targetDb:Db|undefined;
 try{
  targetDb=createDatabase(destination,{max:1});
  return await sourceDb.transaction(async sourceTx=>{
   await sourceTx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await sourceTx.query("SET LOCAL TIME ZONE 'UTC'");await sourceTx.query("SET LOCAL DateStyle='ISO, YMD'");
   await sourceTx.query(`SET LOCAL search_path TO ${identifier(source.schema)}`);
   const data=await snapshot(sourceTx,source.schema);
   const plan={mode:options.apply?'applied':'dry-run',destinationEnvironment:options.config.DATABASE_ENVIRONMENT,sourceMigrationCount:data.migrations.length,tableCount:data.tables.length,rowCount:data.tables.reduce((sum,table)=>sum+table.rows.length,0),counts:Object.fromEntries(data.tables.map(table=>[table.name,table.rows.length]))};
   await targetDb!.transaction(async targetTx=>{
    if(!options.apply)await targetTx.query('SET TRANSACTION READ ONLY');
    await targetTx.query("SET LOCAL TIME ZONE 'UTC'");await targetTx.query("SET LOCAL DateStyle='ISO, YMD'");await targetTx.query('SET LOCAL search_path TO public');
    await requireEmptyDestination(targetTx,options.apply);
    if(options.apply)await applySnapshot(targetTx,data);
   });
   return {...plan,verified:options.apply,sourceUnchanged:true};
  });
 }finally{await sourceDb.close();await targetDb?.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const flags=process.argv.slice(2);if(flags.some(flag=>!['--apply','--allow-empty-production'].includes(flag)))refuse('Unsupported transfer option.');
  const result=await transferLocalToNeon({sourceUrl:process.env.SOURCE_DATABASE_URL,config:readConfig(),apply:flags.includes('--apply'),allowEmptyProduction:flags.includes('--allow-empty-production')});
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch{
  process.stderr.write('Transfer refused or failed. Check the selected local preview source, migration checksums, empty Neon destination, matching direct connection and explicit environment flags. No database records or connection details were logged.\n');
  process.exitCode=1;
 }
}
