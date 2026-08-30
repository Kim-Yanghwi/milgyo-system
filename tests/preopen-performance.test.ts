import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(file, 'utf8');

test('transaction import uses bounded set-based D1 writes and remains race-safe', () => {
  const source = read('functions/api/accounting-operations/action.ts');
  assert.match(source, /const bulkInsertImportTransactions/);
  assert.match(source, /FROM json_each\(\?\).*ON CONFLICT\(external_key\) DO NOTHING/s);
  assert.doesNotMatch(source, /SELECT id FROM accounting_import_transactions WHERE external_key=\?/,
    'the 1,000-row import path must not issue one duplicate lookup per row');
  assert.match(source, /SELECT COUNT\(\*\) AS count FROM accounting_import_transactions WHERE batch_id=\?/,
    'final imported count must come from rows actually committed for the batch');
});

test('auto reconciliation loads and writes candidates set-wise', () => {
  const source = read('functions/api/accounting-operations/action.ts');
  assert.match(source, /const loadAutoMatchCandidateMap/);
  assert.match(source, /WHERE t\.id IN \(SELECT CAST\(value AS TEXT\) FROM json_each\(\?\)\)/);
  assert.match(source, /ROW_NUMBER\(\) OVER\(PARTITION BY s\.tx_id/);
  assert.match(source, /const loadMatchedTargetKeys/);
  assert.match(source, /const applyAutoMatchUpdates/);
  assert.match(source, /status='unmatched',suggested_type=NULL,suggested_id=NULL,suggested_score=NULL,suggested_reason=NULL/,
    'a stale suggestion must be cleared when it no longer has a valid candidate');
  assert.match(source, /s\.direction='out'/,
    'refund\/inflow card rows must not be auto-matched to expense targets');
});

test('auto reconciliation candidate lookups have supporting pre-open indexes', () => {
  const migration = read('migrations/accounting/0017_v83_preopen_performance_indexes.sql');
  for (const name of [
    'idx_import_tx_match_target',
    'idx_donations_auto_match',
    'idx_resolutions_auto_match',
    'idx_card_transactions_auto_match',
  ]) assert.match(migration, new RegExp(name));
  const source = read('functions/api/accounting-operations/action.ts');
  assert.match(source, /donation_date BETWEEN date\(s\.transaction_date,'-5 day'\) AND date\(s\.transaction_date,'\+5 day'\)/);
  assert.match(source, /resolution_date BETWEEN date\(s\.transaction_date,'-7 day'\) AND date\(s\.transaction_date,'\+7 day'\)/);
  assert.match(source, /transaction_date BETWEEN date\(s\.transaction_date,'-3 day'\) AND date\(s\.transaction_date,'\+3 day'\)/);
});

test('R2-backed management attachments use binary streaming in the current UI', () => {
  for (const file of [
    'functions/api/documents/attachment-data.ts',
    'functions/api/received/attachment-data.ts',
    'functions/api/registers/attachment-data.ts',
  ]) {
    const source = read(file);
    assert.match(source, /binary\?: boolean/);
    assert.match(source, /new Response\(object\.body/,
      `${file} must return the R2 body directly for binary downloads`);
    assert.match(source, /X-File-Name/);
  }
  const home = read('src/pages/index.astro');
  assert.match(home, /attachmentId,binary:true/);
  assert.match(home, /downloadAttachmentBinary\('\/api\/documents\/attachment-data'/);
  assert.match(home, /downloadAttachmentBinary\('\/api\/received\/attachment-data'/);
  const registers = read('src/pages/register-management.astro');
  assert.match(registers, /attachmentId: id, binary: true/);
});
