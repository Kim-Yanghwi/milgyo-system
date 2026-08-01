export const ACCOUNTING_R2_PREFIX = 'accounting/';
export const MAIN_R2_PREFIXES = ['documents/', 'registry/', 'registers/'] as const;

const normalizeKey = (value: unknown) => String(value ?? '').trim();

export const assertR2KeyWithinPrefixes = (
  value: unknown,
  allowedPrefixes: readonly string[],
  context = 'R2 작업',
) => {
  const key = normalizeKey(value);
  const invalidSyntax = !key || key.startsWith('/') || key.includes('\\') || key.split('/').includes('..');
  const allowed = !invalidSyntax && allowedPrefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
  if (!allowed) {
    throw new Error(`${context} 차단: 허용된 경로(${allowedPrefixes.join(', ')}) 밖의 객체 키입니다: ${key || '(빈 값)'}`);
  }
  return key;
};

export const assertR2KeysWithinPrefixes = (
  values: unknown[],
  allowedPrefixes: readonly string[],
  context = 'R2 일괄 작업',
) => values.map((value) => assertR2KeyWithinPrefixes(value, allowedPrefixes, context));

export const assertAccountingR2Key = (value: unknown, context = '회계 R2 작업') =>
  assertR2KeyWithinPrefixes(value, [ACCOUNTING_R2_PREFIX], context);
