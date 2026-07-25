type D1Result<T = unknown> = { results?: T[] };
type D1PreparedStatement = { bind: (...values: any[]) => D1PreparedStatement; run: () => Promise<any>; all: <T = any>() => Promise<D1Result<T>>; first: <T = any>() => Promise<T | null> };
type D1Database = { prepare: (sql: string) => D1PreparedStatement; batch: (statements: D1PreparedStatement[]) => Promise<any[]> };
type PagesFunction<Env = unknown> = (context: { request: Request; env: Env }) => Promise<Response> | Response;

type R2ObjectBody = { arrayBuffer: () => Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } };
type R2Bucket = { put: (key: string, value: ArrayBuffer | ArrayBufferView | string, options?: any) => Promise<any>; get: (key: string) => Promise<R2ObjectBody | null>; delete: (keys: string | string[]) => Promise<void> };
