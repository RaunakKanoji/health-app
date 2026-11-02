/** Pure server configuration helpers. Never include a URL in configuration errors. */
export type DatabaseEnvironment = 'development' | 'test' | 'staging' | 'production';
export type DatabaseSettings = {
  DATABASE_URL: string;
  DATABASE_DIRECT_URL?: string;
  DATABASE_RUNTIME_URL?: string;
  DATABASE_URL_UNPOOLED?: string;
  DATABASE_ENVIRONMENT?: DatabaseEnvironment;
};

export function databaseEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid PostgreSQL connection configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error('Database connections require a PostgreSQL URL with a host and database name.');
  }
  // pg permits query-string overrides. Reject these so validation describes the actual destination.
  if (['host', 'hostaddr', 'port', 'database', 'dbname', 'user', 'password'].some(key => url.searchParams.has(key))) {
    throw new Error('Database destination and credentials must be specified in the URL authority and path.');
  }
  if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) {
    throw new Error('Database URL parameters must not be repeated.');
  }
  if (!isLocalDatabase(url) && !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')) {
    throw new Error('Remote PostgreSQL connections require TLS: set sslmode=verify-full.');
  }
  return url;
}

export function isLocalDatabase(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function databaseEnvironment(config: DatabaseSettings): DatabaseEnvironment {
  const url = databaseEndpoint(config.DATABASE_URL);
  if (config.DATABASE_ENVIRONMENT) return config.DATABASE_ENVIRONMENT;
  if (isLocalDatabase(url)) return 'development';
  throw new Error('DATABASE_ENVIRONMENT must explicitly identify the remote database environment.');
}

function target(url: URL): string {
  // Neon gives pooled and direct endpoints the same name apart from this suffix.
  const host = url.hostname.endsWith('.neon.tech') ? url.hostname.replace(/-pooler(?=\.)/, '') : url.hostname;
  return JSON.stringify([host, url.port || '5432', decodeURIComponent(url.pathname), url.searchParams.get('options') ?? '']);
}

export function validateDatabaseSettings(config: DatabaseSettings): void {
  const runtime = databaseEndpoint(config.DATABASE_URL);
  databaseEnvironment(config);
  if(config.DATABASE_RUNTIME_URL&&target(runtime)!==target(databaseEndpoint(config.DATABASE_RUNTIME_URL))) {
    throw new Error('The restricted runtime connection must select the same branch, database, port and schema options as DATABASE_URL.');
  }
  for (const value of [config.DATABASE_DIRECT_URL, config.DATABASE_URL_UNPOOLED]) {
    if (!value) continue;
    const direct = databaseEndpoint(value);
    if (direct.hostname.includes('-pooler.')) throw new Error('The direct migration connection must not use a pooled endpoint.');
    if (target(runtime) !== target(direct)) throw new Error('Runtime and direct database connections must select the same branch, database, port and schema options.');
  }
}

/** Explicitly designated development/test targets only; this is not production deployment approval. */
export function assertDevelopmentDatabase(config: DatabaseSettings): void {
  validateDatabaseSettings(config);
  if (!['development', 'test'].includes(databaseEnvironment(config))) {
    throw new Error('This operation is restricted to an explicitly selected development or test database.');
  }
}

export function migrationConnection(config: DatabaseSettings): string {
  assertDevelopmentDatabase(config);
  const direct = config.DATABASE_DIRECT_URL ?? config.DATABASE_URL_UNPOOLED;
  if (direct) return direct;
  if (isLocalDatabase(databaseEndpoint(config.DATABASE_URL))) return config.DATABASE_URL;
  throw new Error('Remote migrations require DATABASE_DIRECT_URL from the selected development branch.');
}

/** Preserve local demo startup; remote runtimes only verify already-applied migrations. */
export function allowLocalBootstrap(config: DatabaseSettings): boolean {
  return isLocalDatabase(databaseEndpoint(config.DATABASE_URL)) && ['development', 'test'].includes(databaseEnvironment(config));
}
