type D1Result<T = unknown> = { results?: T[]; success?: boolean; meta?: Record<string, unknown> };
type D1PreparedStatement = {
  bind: (...values: any[]) => D1PreparedStatement;
  run: () => Promise<any>;
  all: <T = any>() => Promise<D1Result<T>>;
  first: <T = any>() => Promise<T | null>;
};
type D1Database = {
  prepare: (sql: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<any[]>;
};
type PagesFunction<Env = unknown> = (context: { request: Request; env: Env; next: () => Promise<Response> }) => Promise<Response> | Response;

type R2ObjectBody = { arrayBuffer: () => Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } };
type R2Object = { key: string; size?: number; uploaded?: Date };
type R2Objects = { objects?: R2Object[]; truncated?: boolean; cursor?: string };
type R2Bucket = {
  put: (key: string, value: ArrayBuffer | ArrayBufferView | string, options?: any) => Promise<any>;
  get: (key: string) => Promise<R2ObjectBody | null>;
  head: (key: string) => Promise<R2Object | null>;
  list: (options?: { prefix?: string; cursor?: string; limit?: number }) => Promise<R2Objects>;
  delete: (keys: string | string[]) => Promise<void>;
};

type ScheduledController = { cron: string; scheduledTime: number };
type ExecutionContext = { waitUntil: (promise: Promise<any>) => void; passThroughOnException?: () => void };

type MilgyoEnv = {
  DB: D1Database;
  ACCOUNTING_DB: D1Database;
  FILES?: R2Bucket;
  ACCOUNTING_FILES?: R2Bucket;
};
