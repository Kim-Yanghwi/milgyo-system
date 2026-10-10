/** Shared upload checks. Container signatures are not an antivirus scan. */
const MAX_BYTES = 4 * 1024 * 1024;
const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', hwp: 'application/x-hwp', hwpx: 'application/vnd.hancom.hwpx',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
};
export function decodeUploadBase64(value: string, maxBytes = MAX_BYTES): Uint8Array | null {
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const binary = atob(value);
    if (!binary.length || binary.length > maxBytes) return null;
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch { return null; }
}
export function inspectMainAttachment(name: string, bytes: Uint8Array): { ok: true; mimeType: string } | { ok: false; message: string } {
  const rejected = (message: string) => ({ ok: false as const, message });
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f/\\:\u202a-\u202e\u2066-\u2069]/.test(name) || /[.\s]$/.test(name)) {
    return rejected('\ud30c\uc77c\uba85\uc5d0 \ud5c8\uc6a9\ub418\uc9c0 \uc54a\ub294 \ubb38\uc790\uac00 \uc788\uc2b5\ub2c8\ub2e4.');
  }
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (!MIME[ext] || !name.includes('.')) return rejected('\ud5c8\uc6a9\ub418\uc9c0 \uc54a\ub294 \ud30c\uc77c \ud615\uc2dd\uc785\ub2c8\ub2e4.');
  if (!bytes.length || bytes.length > MAX_BYTES) return rejected('\ud30c\uc77c\uc740 4MB \uc774\ud558\uc774\uba70 \ube44\uc5b4 \uc788\uc9c0 \uc54a\uc544\uc57c \ud569\ub2c8\ub2e4.');
  const starts = (...signature: number[]) => signature.every((value, i) => bytes[i] === value);
  const zip = starts(0x50, 0x4b, 3, 4) || starts(0x50, 0x4b, 5, 6);
  const ole = starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  const text = new TextDecoder().decode(bytes.subarray(0, 16));
  let matches = false;
  if (['zip', 'hwpx', 'docx', 'xlsx', 'pptx', 'odt', 'ods'].includes(ext)) matches = zip;
  else if (['hwp', 'doc', 'xls', 'ppt'].includes(ext)) matches = ole;
  else if (ext === 'pdf') matches = starts(37, 80, 68, 70, 45);
  else if (ext === 'png') matches = starts(137, 80, 78, 71, 13, 10, 26, 10);
  else if (ext === 'jpg' || ext === 'jpeg') matches = starts(255, 216, 255);
  else if (ext === 'gif') matches = text.startsWith('GIF87a') || text.startsWith('GIF89a');
  else if (ext === 'webp') matches = text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP';
  else if (ext === 'txt' || ext === 'csv') matches = !bytes.some((byte) => byte === 0 || (byte < 9) || (byte > 13 && byte < 32));
  if (!matches) return rejected('\ud655\uc7a5\uc790\uc640 \uc2e4\uc81c \ud30c\uc77c \ud615\uc2dd\uc774 \uc77c\uce58\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.');
  return { ok: true, mimeType: MIME[ext] };
}
