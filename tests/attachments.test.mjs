import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, open, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { AttachmentStore, ATTACHMENT_LIMITS } from '../src/main/attachments.mjs';
import { createDocumentFixtures } from './fixtures/document-fixtures.mjs';

const execFileAsync = promisify(execFile);
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helperPath = path.join(project, 'resources/document-reader');

before(async () => {
  if (process.platform === 'darwin') {
    try { await access(helperPath); }
    catch { await execFileAsync(process.execPath, [path.join(project, 'scripts/build-document-reader.mjs')], { timeout: 120000 }); }
  }
});

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-collab-attachments-'));
  const sourceDir = path.join(root, 'sources');
  const storageDir = path.join(root, 'stored');
  await mkdir(sourceDir);
  const store = new AttachmentStore({ storageDir, pdfHelperPath: helperPath, ...options });
  await store.init();
  t.after(() => rm(root, { recursive: true, force: true }));
  async function source(name, data) { const filename = path.join(sourceDir, name); await writeFile(filename, data); return filename; }
  return { root, sourceDir, storageDir, store, source };
}

function simplePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids = [];
  const fontObject = 3 + pages.length * 2;
  for (const text of pages) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    const escaped = text.replace(/[\\()]/g, '\\$&');
    const content = text ? `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let data = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  data += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  data += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return data;
}

test('CSV and TSV preserve original delimiters, quotes, multiline cells, and formula-looking data', async (t) => {
  const { store, source } = await setup(t);
  const csv = 'name,notes,total\r\n"Smith, Jo","first line\nsecond line",42\r\n"=HYPERLINK(\"\"https://example.com\"\")",plain,0\r\n';
  const tsv = 'name\tvalue\nAna\t00123\n';
  const result = await store.importFiles([await source('research.csv', csv), await source('ids.tsv', tsv)]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.attachments.length, 2);
  assert.equal(store.get(result.attachments[0].id).text, csv);
  assert.equal(store.get(result.attachments[1].id).text, tsv);
  assert.equal(result.attachments[0].extension, 'csv');
  assert.equal(result.attachments[0].charCount, csv.length);
});

test('UTF-8 and BOM-marked UTF-16 text retain Unicode characters', async (t) => {
  const { store, source } = await setup(t);
  const text = 'A café note — 日本語 and 😀.\nSecond line.';
  const little = Buffer.from(text, 'utf16le');
  const big = Buffer.from(little).swap16();
  const result = await store.importFiles([
    await source('utf8.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])),
    await source('little.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), little])),
    await source('big.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), big])),
  ]);
  assert.deepEqual(result.errors, []);
  for (const attachment of result.attachments) assert.equal(store.get(attachment.id).text, text);
});

test('native Word and RTF conversion extracts text from actual DOC, DOCX, and RTF files', { skip: process.platform !== 'darwin' }, async (t) => {
  const { store, source, sourceDir } = await setup(t);
  const input = await source('original.txt', 'Project brief for café research\n\nA second paragraph with a measurable target: 42.\n');
  const filenames = [];
  for (const extension of ['doc', 'docx', 'rtf']) {
    const output = path.join(sourceDir, `brief.${extension}`);
    await execFileAsync('/usr/bin/textutil', ['-convert', extension, '-output', output, '--', input]);
    filenames.push(output);
  }
  const result = await store.importFiles(filenames);
  assert.deepEqual(result.errors, []);
  assert.equal(result.attachments.length, 3);
  for (const attachment of result.attachments) {
    assert.match(store.get(attachment.id).text, /Project brief for café research/);
    assert.match(store.get(attachment.id).text, /measurable target: 42/);
    assert.ok(attachment.warnings.some(warning => warning.includes('Images')));
  }
});

test('PDF text extraction retains page boundaries and rejects a wholly blank PDF', { skip: process.platform !== 'darwin' }, async (t) => {
  const { store, source } = await setup(t);
  const result = await store.importFiles([
    await source('brief.pdf', simplePdf(['First page: project brief.', 'Second page: success target is 42.'])),
    await source('blank.pdf', simplePdf([''])),
  ]);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].pages, 2);
  const text = store.get(result.attachments[0].id).text;
  assert.match(text, /=== Page 1 ===\nFirst page: project brief/);
  assert.match(text, /=== Page 2 ===\nSecond page: success target is 42/);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /No readable text/);
});

test('image-only PDF pages use local OCR and disclose recognition uncertainty', { skip: process.platform !== 'darwin', timeout: 60000 }, async (t) => {
  const { store, sourceDir } = await setup(t);
  const filename = path.join(sourceDir, 'scan.pdf');
  await execFileAsync('/usr/bin/swift', [path.join(project, 'tests/fixtures/create-scan.swift'), filename], { timeout: 50000 });
  const result = await store.importFiles([filename]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.attachments.length, 1);
  assert.match(store.get(result.attachments[0].id).text, /Project target is 42/i);
  assert.ok(result.attachments[0].warnings.some(warning => warning.includes('OCR')));
});

test('portable PDF extraction preserves page text and explicitly reports pages needing OCR', async (t) => {
  const { store, source, storageDir } = await setup(t, { platform: 'win32' });
  const result = await store.importFiles([
    await source('brief.pdf', simplePdf(['First page: portable project brief.', '', 'Third page: success target is 42.'])),
    await source('blank.pdf', simplePdf([''])),
    await source('fake.pdf', 'Not a PDF'),
  ]);
  assert.equal(result.attachments.length, 1, JSON.stringify(result.errors));
  const attachment = result.attachments[0];
  const text = store.get(attachment.id).text;
  assert.equal(attachment.pages, 3);
  assert.match(text, /=== Page 1 ===\nFirst page: portable project brief/);
  assert.match(text, /=== Page 2 ===\n\[No embedded text/);
  assert.match(text, /=== Page 3 ===\nThird page: success target is 42/);
  assert.ok(attachment.warnings.some(warning => /Pages 2.*OCR was not run/.test(warning)));
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].error, /No readable text.*searchable PDF/);
  assert.match(result.errors[1].error, /not a readable PDF/);
  assert.equal((await readdir(storageDir)).filter(name => name.startsWith('.extract-')).length, 0);
});

test('portable RTF retains Unicode and rejects legacy DOC with an export instruction', async (t) => {
  const { store, source } = await setup(t, { platform: 'win32' });
  const result = await store.importFiles([
    await source('brief.rtf', String.raw`{\rtf1\ansi\ansicpg1252\uc1 Project caf\'e9 research\par Japanese: \u26085?\u26412?\u35486?\par Success target is 42.}`),
    await source('legacy.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  ]);
  assert.equal(result.attachments.length, 1, JSON.stringify(result.errors));
  const text = store.get(result.attachments[0].id).text;
  assert.match(text, /Project café research/);
  assert.match(text, /Japanese: 日本語/);
  assert.match(text, /Success target is 42/);
  assert.match(result.errors[0].error, /Legacy DOC.*exported as DOCX/);
});

test('portable DOCX extracts Unicode, tables, and headers without loading external document parts', async (t) => {
  const { store, source, sourceDir } = await setup(t, { platform: 'win32' });
  const fixtures = await createDocumentFixtures(sourceDir);
  const original = fixtures.find(item => item.name === 'brief.docx');
  const zip = await JSZip.loadAsync(await readFile(original.path));
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <w:body>
        <w:p><w:r><w:t>Project café — 日本語</w:t></w:r></w:p>
        <w:p><w:hyperlink r:id="externalLink"><w:r><w:t>Linked source</w:t></w:r></w:hyperlink></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Target</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:sectPr><w:headerReference w:type="default" r:id="header"/></w:sectPr>
      </w:body>
    </w:document>`);
  zip.file('word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential project header</w:t></w:r></w:p></w:hdr>');
  const privateSource = await source('private.txt', 'PRIVATE_FILE_CONTENT_MUST_NOT_BE_IMPORTED');
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="header" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
    <Relationship Id="externalLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${privateSource}" TargetMode="External"/>
    </Relationships>`);
  const filename = await source('rich.docx', await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await store.importFiles([filename]);
  assert.deepEqual(result.errors, []);
  const text = store.get(result.attachments[0].id).text;
  assert.match(text, /Project café — 日本語/);
  assert.match(text, /Linked source/);
  assert.match(text, /Target\s+42/);
  assert.match(text, /Document headers and footers[\s\S]*Confidential project header/);
  assert.doesNotMatch(text, /PRIVATE_FILE_CONTENT_MUST_NOT_BE_IMPORTED/);
  // An external altChunk is source content, not a hyperlink: don't attach a
  // deceptively complete excerpt when the linked part wasn't loaded.
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('<w:sectPr>', '<w:altChunk r:id="outsideChunk"/><w:sectPr>'));
  zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace('</Relationships>', `<Relationship Id="outsideChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="${privateSource}" TargetMode="External"/></Relationships>`));
  const incomplete = await store.importFiles([await source('external-content.docx', await zip.generateAsync({ type: 'nodebuffer' }))]);
  assert.equal(incomplete.attachments.length, 0);
  assert.match(incomplete.errors[0].error, /content could not be read.*no partial text/);
});

test('portable rich documents reject excess text rather than retaining a truncated source', async (t) => {
  const { store, source, storageDir } = await setup(t, { platform: 'win32' });
  const result = await store.importFiles([
    await source('oversized.rtf', `{\\rtf1\\ansi ${'x'.repeat(ATTACHMENT_LIMITS.maxChars + 1)}}`),
  ]);
  assert.equal(result.attachments.length, 0);
  assert.match(result.errors[0].error, /200,000 characters/);
  assert.deepEqual(await readdir(storageDir), []);
});

test('XLSX retains sheets, addresses, rich text, dates, and cached formula values without executing formulas', async (t) => {
  const { store, sourceDir } = await setup(t);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Forecast');
  sheet.getCell('A1').value = 'Revenue';
  sheet.getCell('B1').value = 42;
  sheet.getCell('B2').value = { formula: 'B1*2', result: 84 };
  sheet.getCell('B3').value = { formula: 'SUM(B1:B2)' };
  sheet.getCell('C1').value = { richText: [{ text: 'Important ' }, { text: 'context', font: { bold: true } }] };
  sheet.getCell('A4').value = new Date('2026-10-01T00:00:00.000Z');
  sheet.getCell('A5').value = { text: 'Source', hyperlink: 'https://example.com/report' };
  sheet.mergeCells('D1:E1');
  sheet.getCell('D1').value = 'One merged value';
  workbook.addWorksheet('Private assumptions', { state: 'hidden' }).getCell('A1').value = 'Assume one device';
  const filename = path.join(sourceDir, 'forecast.xlsx');
  await workbook.xlsx.writeFile(filename);
  const result = await store.importFiles([filename]);
  assert.deepEqual(result.errors, []);
  const attachment = result.attachments[0];
  const text = store.get(attachment.id).text;
  assert.match(text, /A1: "Revenue"/);
  assert.match(text, /B2: formula "B1\*2"; saved result "84"/);
  assert.match(text, /B3: formula "SUM\(B1:B2\)"; saved result \[no cached result\]/);
  assert.match(text, /Important context/);
  assert.match(text, /2026-10-01T00:00:00.000Z/);
  assert.match(text, /https:\/\/example.com\/report/);
  assert.equal(text.match(/One merged value/g).length, 1);
  assert.match(text, /Private assumptions.*hidden/);
  assert.equal(attachment.sheets.length, 2);
  assert.ok(attachment.warnings.some(warning => warning.includes('not recalculated')));
});

test('stored attachments survive reload, keep immutable source text, and removal never changes originals', async (t) => {
  const { store, storageDir, source } = await setup(t);
  const filename = await source('note.md', 'The original note.');
  const { attachments } = await store.importFiles([filename]);
  const id = attachments[0].id;
  await writeFile(filename, 'The user edited the source.');
  const reloaded = await new AttachmentStore({ storageDir }).init();
  assert.equal(reloaded.get(id).text, 'The original note.');
  const returned = reloaded.get(id);
  returned.text = 'Mutated caller copy';
  assert.equal(reloaded.get(id).text, 'The original note.');
  assert.equal(reloaded.public(id).text, undefined);
  assert.equal(reloaded.public(id).preview, 'The original note.');
  assert.equal(reloaded.public(id).path, undefined);
  assert.equal(await reloaded.remove(id), true);
  assert.equal(reloaded.get(id), null);
  assert.equal(await readFile(filename, 'utf8'), 'The user edited the source.');
  assert.equal(await reloaded.remove('../../source'), false);
  assert.throws(() => reloaded.resolve([id]), /no longer available/);
});

test('bad, missing, unsupported, and binary inputs report per-file errors while valid files succeed', async (t) => {
  const { store, source, sourceDir } = await setup(t);
  const result = await store.importFiles([
    await source('script.js', 'console.log("not executed")'),
    await source('binary.txt', Buffer.from([1, 0, 1, 0])),
    await source('bad-encoding.txt', Buffer.from([0xc0, 0x80])),
    path.join(sourceDir, 'missing.txt'),
    await source('not-office.xlsx', 'This is not an Office archive.'),
    await source('valid.json', '{"goal":"valid source"}'),
  ]);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].name, 'valid.json');
  assert.equal(result.errors.length, 5);
  assert.ok(result.errors.some(item => /Unsupported file type/.test(item.error)));
  assert.ok(result.errors.some(item => /binary/.test(item.error)));
  assert.ok(result.errors.some(item => /encoding/.test(item.error)));
  assert.ok(result.errors.some(item => /could not be found/.test(item.error)));
});

test('size and character limits reject excess input without silently truncating it', async (t) => {
  const { store, source, sourceDir } = await setup(t);
  const oversized = path.join(sourceDir, 'oversized.txt');
  const handle = await open(oversized, 'w');
  await handle.truncate(ATTACHMENT_LIMITS.maxBytes + 1);
  await handle.close();
  const result = await store.importFiles([
    oversized,
    await source('too-many-characters.txt', 'x'.repeat(ATTACHMENT_LIMITS.maxChars + 1)),
    await source('maximum.txt', 'x'.repeat(ATTACHMENT_LIMITS.maxChars)),
  ]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].error, /25 MB/);
  assert.match(result.errors[1].error, /200,000 characters/);
  assert.equal(result.attachments.length, 1);
  assert.equal(store.get(result.attachments[0].id).text.length, ATTACHMENT_LIMITS.maxChars);
  assert.equal(result.attachments[0].preview.length, 1500);
  assert.equal(result.attachments[0].previewTruncated, true);
});

test('aggregate context and eight-file limits are enforced before a debate', async (t) => {
  const { store, source } = await setup(t);
  const files = await Promise.all(Array.from({ length: 9 }, (_, index) => source(`note-${index}.txt`, `Note ${index}`)));
  const batch = await store.importFiles(files);
  assert.equal(batch.attachments.length, 8);
  assert.equal(batch.errors.length, 1);
  assert.equal(store.resolve(batch.attachments.map(attachment => attachment.id)).length, 8);
  assert.throws(() => store.resolve([...batch.attachments.map(attachment => attachment.id), 'extra']), /8 files/);
  assert.throws(() => store.resolve([batch.attachments[0].id, batch.attachments[0].id]), /more than once/);
  const large = await store.importFiles([await source('large-a.txt', 'a'.repeat(110000)), await source('large-b.txt', 'b'.repeat(110000))]);
  assert.equal(large.errors.length, 0);
  assert.throws(() => store.resolve(large.attachments.map(attachment => attachment.id)), /200,000 characters in total/);
});
