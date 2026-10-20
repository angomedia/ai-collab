import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const execFileAsync = promisify(execFile);
export const ATTACHMENT_LIMITS = Object.freeze({ maxFiles: 8, maxBytes: 25 * 1024 * 1024, maxChars: 200000 });
export const SUPPORTED_EXTENSIONS = Object.freeze(['pdf', 'doc', 'docx', 'rtf', 'txt', 'md', 'csv', 'tsv', 'json', 'xlsx']);
const PLAIN = new Set(['txt', 'md', 'csv', 'tsv', 'json']);
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DEFAULT_HELPER = fileURLToPath(new URL('../../resources/document-reader', import.meta.url));
const TOO_MUCH_TEXT = 'This file contains more than 200,000 characters. Split it into smaller files; no text was attached.';

function friendlyError(error) {
  if (error?.code === 'ENOENT') return 'The file could not be found. Select it again from its current location.';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'This file could not be read. Check its permissions or choose a readable copy.';
  return error?.message || String(error);
}

function checkText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('No readable text was found in this file.');
  if (text.length > ATTACHMENT_LIMITS.maxChars) throw new Error(TOO_MUCH_TEXT);
  if (/[\u0000-\u0008\u000e-\u001f]/u.test(text)) throw new Error('This file contains binary or unsupported control characters. Export it as UTF-8 text.');
  return text;
}

function decodeText(buffer) {
  let encoding = 'utf-8';
  let start = 0;
  if (buffer.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0])) || buffer.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) {
    throw new Error('UTF-32 text is not supported. Save this file as UTF-8 or UTF-16 text.');
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) { encoding = 'utf-16le'; start = 2; }
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) { encoding = 'utf-16be'; start = 2; }
  else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) start = 3;
  try { return checkText(new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(start))); }
  catch (error) {
    if (error instanceof TypeError) throw new Error('The text encoding could not be read. Save this file as UTF-8, or UTF-16 with a byte-order mark.');
    throw error;
  }
}

// Check ZIP metadata before a document parser expands a DOCX/XLSX archive.
// The files are parsed as data; archive entries are never extracted to source paths.
function checkOfficeArchive(buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50 && index + 22 + buffer.readUInt16LE(index + 20) === buffer.length) { end = index; break; }
  }
  if (end < 0) throw new Error('This Office file is damaged or is not a supported DOCX/XLSX document.');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const directorySize = buffer.readUInt32LE(end + 12);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || count === 65535 || count > 10000
    || cursor === 0xffffffff || directorySize === 0xffffffff || cursor + directorySize > end) {
    throw new Error('This Office archive is too large or uses an unsupported archive format. Save a smaller standard DOCX/XLSX copy.');
  }
  let expandedBytes = 0;
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('This Office archive is damaged.');
    if (buffer.readUInt16LE(cursor + 8) & 1) throw new Error('Password-protected Office files are not supported. Choose an unlocked copy.');
    expandedBytes += buffer.readUInt32LE(cursor + 24);
    if (expandedBytes > 100 * 1024 * 1024) throw new Error('This Office file expands beyond the 100 MB processing limit. Save a smaller copy.');
    cursor += 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    if (cursor > end) throw new Error('This Office archive is damaged.');
  }
}

async function readBoundedFile(filename) {
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Choose a file, rather than a folder or device.');
    if (stat.size > ATTACHMENT_LIMITS.maxBytes) throw new Error('This file exceeds the 25 MB limit. Choose a smaller file.');
    const chunks = [];
    let size = 0;
    // Recheck the limit while reading, in case the source file changes after stat().
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, ATTACHMENT_LIMITS.maxBytes - size + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > ATTACHMENT_LIMITS.maxBytes) throw new Error('This file exceeds the 25 MB limit. Choose a smaller file.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally { await file.close(); }
}

async function readDocumentWorker(module, workerData, label, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(module, import.meta.url), {
      workerData: { ...workerData, maxChars: ATTACHMENT_LIMITS.maxChars },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Wait for open parser handles to close before deleting scratch files on Windows.
      await worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`This ${label} took too long to read. Save a smaller copy or a text export.`)), timeoutMs);
    worker.once('message', result => result.error ? finish(new Error(result.error)) : finish(null, result));
    worker.once('error', error => finish(new Error(`This ${label} could not be read: ${error.message}`)));
    worker.once('exit', code => { if (!settled) finish(new Error(`The ${label} reader stopped unexpectedly (${code}). Choose a smaller or repaired copy.`)); });
  });
}

export class AttachmentStore {
  constructor({ storageDir, pdfHelperPath = DEFAULT_HELPER, platform = process.platform }) {
    if (typeof storageDir !== 'string' || !storageDir) throw new Error('Attachment storage is required.');
    this.storageDir = path.resolve(storageDir);
    this.pdfHelperPath = pdfHelperPath;
    this.platform = platform;
    this.records = new Map();
  }

  async init() {
    await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    const files = await readdir(this.storageDir);
    for (const filename of files) {
      if (!filename.endsWith('.json') || !ID_PATTERN.test(filename.slice(0, -5))) continue;
      try {
        const record = JSON.parse(await readFile(path.join(this.storageDir, filename), 'utf8'));
        if (record.id !== filename.slice(0, -5) || typeof record.name !== 'string' || !SUPPORTED_EXTENSIONS.includes(record.extension)
          || typeof record.text !== 'string' || record.text.length > ATTACHMENT_LIMITS.maxChars || !Array.isArray(record.warnings)) continue;
        checkText(record.text);
        record.charCount = record.text.length;
        this.records.set(record.id, record);
      } catch { /* A damaged saved attachment must not prevent app startup. */ }
    }
    return this;
  }

  get(id) { return this.records.has(id) ? structuredClone(this.records.get(id)) : null; }

  public(id) {
    const record = this.records.get(id);
    if (!record) return null;
    const { text, sha256, ...metadata } = record;
    return structuredClone({ ...metadata, preview: text.slice(0, 1500), previewTruncated: text.length > 1500 });
  }

  resolve(ids = []) {
    if (!Array.isArray(ids) || ids.length > ATTACHMENT_LIMITS.maxFiles) throw new Error('Attach up to 8 files per debate.');
    if (new Set(ids).size !== ids.length) throw new Error('The same attachment was selected more than once.');
    let total = 0;
    return ids.map(id => {
      const record = typeof id === 'string' && this.records.get(id);
      if (!record) throw new Error('An attachment is no longer available. Remove it and attach the file again.');
      total += record.charCount;
      if (total > ATTACHMENT_LIMITS.maxChars) throw new Error('The selected files exceed 200,000 characters in total. Remove a file or attach smaller excerpts.');
      return structuredClone(record);
    });
  }

  async remove(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return false;
    if (!this.records.has(id)) return false;
    await rm(path.join(this.storageDir, `${id}.json`), { force: true });
    this.records.delete(id);
    return true;
  }

  async importFiles(paths) {
    if (!Array.isArray(paths)) throw new Error('Choose files in the file picker.');
    const attachments = [];
    const errors = [];
    for (const [index, filename] of paths.entries()) {
      const name = typeof filename === 'string' ? path.basename(filename).replace(/[\u0000-\u001f]/g, '_') : 'Unknown file';
      if (index >= ATTACHMENT_LIMITS.maxFiles) { errors.push({ name, error: 'Attach up to 8 files at a time.' }); continue; }
      try {
        if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Choose the file again using the file picker.');
        const extension = path.extname(name).slice(1).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.includes(extension)) throw new Error('Unsupported file type. Use PDF, DOC, DOCX, RTF, TXT, MD, CSV, TSV, JSON, or XLSX.');
        const buffer = await readBoundedFile(filename);
        const extracted = await this.extract(buffer, extension);
        const text = checkText(extracted.text);
        const id = randomUUID();
        const record = {
          id, name, extension, size: buffer.length, charCount: text.length, text,
          warnings: [...new Set(extracted.warnings || [])],
          ...(extracted.pages ? { pages: extracted.pages } : {}),
          ...(extracted.sheets ? { sheets: extracted.sheets } : {}),
          sha256: createHash('sha256').update(buffer).digest('hex'), createdAt: new Date().toISOString(),
        };
        const destination = path.join(this.storageDir, `${id}.json`);
        await writeFile(`${destination}.tmp`, JSON.stringify(record), { mode: 0o600 });
        await rename(`${destination}.tmp`, destination);
        this.records.set(id, record);
        attachments.push(this.public(id));
      } catch (error) { errors.push({ name, error: friendlyError(error) }); }
    }
    return { attachments, errors };
  }

  async extract(buffer, extension) {
    if (PLAIN.has(extension)) return { text: decodeText(buffer), warnings: [] };
    if (extension === 'xlsx' || extension === 'docx') checkOfficeArchive(buffer);
    const scratch = await mkdtemp(path.join(this.storageDir, '.extract-'));
    const source = path.join(scratch, `document.${extension}`);
    try {
      await writeFile(source, buffer, { mode: 0o600 });
      if (extension === 'xlsx') return await readDocumentWorker('./spreadsheet-reader.mjs', { filename: source }, 'workbook');
      if (this.platform !== 'darwin') {
        if (extension === 'doc') throw new Error('Legacy DOC files need to be exported as DOCX, PDF, RTF, or text on this platform. Open the document in Word or LibreOffice and save a copy.');
        if (extension === 'pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('This file is not a readable PDF document.');
        return await readDocumentWorker('./document-reader.mjs', { filename: source, extension }, 'document', extension === 'pdf' ? 120000 : 60000);
      }
      if (extension === 'pdf') {
        if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('This file is not a readable PDF document.');
        let result;
        try {
          result = await execFileAsync(this.pdfHelperPath, [source, String(ATTACHMENT_LIMITS.maxChars)], { timeout: 120000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
        } catch (error) {
          if (error.code === 'ENOENT') throw new Error('The PDF reader is unavailable. Reinstall AI Collab or attach a text export.');
          if (error.killed || error.signal) throw new Error('This PDF took too long to read. Split it into smaller PDFs or use a text export.');
          throw new Error(error.stderr?.trim() || 'The PDF could not be read. Try an unlocked PDF or a text export.');
        }
        let parsed;
        try { parsed = JSON.parse(result.stdout); } catch { throw new Error('The PDF reader returned an unreadable result. Try a text export.'); }
        return parsed;
      }
      try {
        const result = await execFileAsync('/usr/bin/textutil', ['-noload', '-nostore', '-timeout', '20', '-convert', 'txt', '-encoding', 'UTF-8', '-stdout', '--', source], {
          timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer',
        });
        return { text: decodeText(result.stdout), warnings: ['Text was extracted from the document. Images, layout, and embedded objects are not included.'] };
      } catch (error) {
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(TOO_MUCH_TEXT);
        if (error.killed || error.signal) throw new Error('This document took too long to read. Save a smaller text or DOCX copy.');
        if (error.code) throw new Error('This document could not be converted to text. Try an unlocked DOCX or text export.');
        throw error;
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
