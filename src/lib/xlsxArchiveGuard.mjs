const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxEntries: 2000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 500,
});

const u32 = (view, offset) => view.getUint32(offset, true);
const u16 = (view, offset) => view.getUint16(offset, true);

export function validateXlsxArchiveBuffer(buffer, fileSize = buffer?.byteLength ?? 0, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (!(buffer instanceof ArrayBuffer)) throw new Error('엑셀 파일을 읽을 수 없습니다.');
  if (!Number.isFinite(fileSize) || fileSize <= 0) throw new Error('비어 있는 파일은 가져올 수 없습니다.');
  if (fileSize > limits.maxFileBytes || buffer.byteLength > limits.maxFileBytes) {
    throw new Error(`엑셀 파일은 ${Math.floor(limits.maxFileBytes / 1024 / 1024)}MB 이하만 가져올 수 있습니다.`);
  }
  if (buffer.byteLength < 22) throw new Error('올바른 XLSX 파일이 아닙니다.');

  const view = new DataView(buffer);
  const eocdMin = Math.max(0, buffer.byteLength - 65_557);
  let eocd = -1;
  for (let offset = buffer.byteLength - 22; offset >= eocdMin; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('XLSX 압축 구조를 확인할 수 없습니다. 파일이 손상되었거나 지원되지 않는 형식입니다.');

  const diskEntries = u16(view, eocd + 8);
  const totalEntries = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  if (diskEntries === 0xffff || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 형식의 대용량 XLSX 파일은 안전을 위해 가져올 수 없습니다.');
  }
  if (diskEntries !== totalEntries || totalEntries < 1 || totalEntries > limits.maxEntries) {
    throw new Error('XLSX 내부 파일 수가 비정상적으로 많거나 구조가 올바르지 않습니다.');
  }
  if (centralOffset + centralSize > buffer.byteLength) throw new Error('XLSX 중앙 디렉터리 구조가 올바르지 않습니다.');

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let offset = centralOffset;
  let totalUncompressed = 0;
  let hasContentTypes = false;
  let hasWorkbook = false;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.byteLength || u32(view, offset) !== 0x02014b50) throw new Error('XLSX 내부 파일 목록이 손상되었습니다.');
    const compressed = u32(view, offset + 20);
    const uncompressed = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > buffer.byteLength) throw new Error('XLSX 내부 파일 목록의 길이가 올바르지 않습니다.');

    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength)).replaceAll('\\', '/');
    if (name === '[Content_Types].xml') hasContentTypes = true;
    if (name === 'xl/workbook.xml') hasWorkbook = true;
    if (uncompressed > limits.maxEntryBytes) throw new Error('XLSX 내부에 지나치게 큰 항목이 있어 가져오기를 중단했습니다.');
    totalUncompressed += uncompressed;
    if (totalUncompressed > limits.maxUncompressedBytes) throw new Error('XLSX 압축 해제 예상 크기가 너무 커 가져오기를 중단했습니다.');
    if (uncompressed > 0 && compressed === 0) throw new Error('XLSX 압축 정보가 비정상적입니다.');
    if (compressed > 0 && uncompressed / compressed > limits.maxCompressionRatio) throw new Error('XLSX 압축률이 비정상적으로 높아 안전을 위해 가져오기를 중단했습니다.');
    offset = next;
  }
  if (!hasContentTypes || !hasWorkbook) throw new Error('정상적인 Excel XLSX 문서 구조를 찾지 못했습니다.');
  return { entries: totalEntries, totalUncompressedBytes: totalUncompressed };
}

export const xlsxArchiveLimits = DEFAULT_LIMITS;
