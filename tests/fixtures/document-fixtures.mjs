import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export function simplePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids = [];
  const font = 3 + pages.length * 2;
  for (const text of pages) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    const escaped = text.replace(/[\\()]/g, '\\$&');
    const content = text ? `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${page + 1} 0 R >>`);
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
  return data + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

export async function createDocumentFixtures(directory) {
  await mkdir(directory, { recursive: true });
  const fixtures = [
    { name: 'shipments.csv', expected: 'Alpha,17', content: 'shipment,units\nAlpha,17\nBeta,25\n' },
    { name: 'target.pdf', expected: 'Project target is 42', content: simplePdf(['Project target is 42']) },
    { name: 'notes.rtf', expected: 'Do not count shipments twice', content: '{\\rtf1\\ansi Do not count shipments twice.\\par}' },
  ];
  for (const fixture of fixtures) await writeFile(path.join(directory, fixture.name), fixture.content);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Count Alpha and Beta once each.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  await writeFile(path.join(directory, 'brief.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  fixtures.push({ name: 'brief.docx', expected: 'Count Alpha and Beta once each' });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Shipments').addRows([['shipment', 'units'], ['Alpha', 17], ['Beta', 25]]);
  await workbook.xlsx.writeFile(path.join(directory, 'shipments.xlsx'));
  fixtures.push({ name: 'shipments.xlsx', expected: 'B2: "17"' });
  return fixtures.map(({ name, expected }) => ({ name, expected, path: path.join(directory, name) }));
}
