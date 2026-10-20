import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { OfficeGenerator, parseOffice } from 'officeparser';

// This worker receives an app-owned copy, never a URL or a document-supplied path.
// Parsers read data only: no Office processes, macros, linked files, or online OCR.
const { filename, extension, maxChars } = workerData;
const warnings = [];
const incompleteCodes = new Set([
  'PAGE_LOAD_FAILED', 'PDF_CONTENT_LIMIT_EXCEEDED', 'TABLE_CELL_LIMIT_EXCEEDED',
  'REPEATED_CONTENT_LIMIT_EXCEEDED', 'ALT_CHUNK_NOT_READ', 'CONTENT_PART_NOT_READ',
]);
let incompleteIssue = false;
function recordIssue(issue) {
  if (incompleteCodes.has(issue.code)) incompleteIssue = true;
  if (issue.code === 'PDF_STRUCT_TREE_UNRELIABLE' || issue.code === 'PDF_NO_TEXT_EXTRACTED') return;
  if (issue.type !== 'info' && warnings.length < 20) warnings.push(`Document reader: ${issue.message}`);
}
function checkComplete() {
  if (incompleteIssue) throw new Error('Some document content could not be read or exceeded the processing limit. Save a smaller or repaired document, or attach a text export; no partial text was attached.');
}
function checkLength(text) {
  if (text.length > maxChars) throw new Error('This file contains more than 200,000 characters. Split it into smaller files; no text was attached.');
  return text;
}

try {
  const buffer = await readFile(filename);
  const require = createRequire(import.meta.url);
  const officeRequire = createRequire(require.resolve('officeparser'));
  const config = {
    fileType: extension,
    ocr: false,
    extractAttachments: false,
    includeRawContent: false,
    serializeRawContent: false,
    onWarning: recordIssue,
    decompressionLimits: {
      maxUncompressedBytes: 100 * 1024 * 1024,
      maxZipEntries: 10000,
      maxTableCells: 200000,
      maxXmlElements: 300000,
      maxRepeatedContent: 1024 * 1024,
    },
    ...(extension === 'pdf' ? {
      // Force the bundled worker; never fall back to a CDN. Our outer worker
      // supplies the time/heap boundary, without spawning the Electron app.
      pdfWorkerSrc: pathToFileURL(officeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href,
      pdfParserConfig: { separateProcess: false, extractTextColor: false },
    } : {}),
  };
  const ast = await parseOffice(buffer, config);
  checkComplete();
  async function textFor(nodes) {
    const result = await OfficeGenerator.generate({ ...ast, content: nodes, auxiliary: undefined }, 'text', {
      includeImages: false,
      renderMetadata: false,
      textConfig: { preserveLayout: false, renderNotes: true },
      onWarning: recordIssue,
    });
    checkComplete();
    return checkLength(result.value);
  }

  let text = '';
  let pages;
  const auxiliary = [
    ...(ast.auxiliary?.headers || []),
    ...(ast.auxiliary?.footers || []),
  ];
  if (extension === 'pdf') {
    const pageNodes = ast.content.filter(node => node.type === 'page');
    pages = pageNodes.length;
    let readable = false;
    const noText = [];
    for (const [index, page] of pageNodes.entries()) {
      const pageNumber = page.metadata?.pageNumber || index + 1;
      let pageText = await textFor([page]);
      if (pageText.trim()) readable = true;
      else {
        noText.push(pageNumber);
        pageText = '[No embedded text; this page may be blank or scanned. OCR was not run.]';
      }
      text = checkLength(`${text}${text ? '\n\n' : ''}=== Page ${pageNumber} ===\n${pageText}`);
    }
    // The parser separates running headers/footers from pages. Keep them rather
    // than silently discarding content, without inventing page associations.
    const extra = auxiliary.length ? await textFor(auxiliary) : '';
    if (extra.trim()) {
      readable = true;
      text = checkLength(`${text}\n\n=== Document headers and footers ===\n${extra}`);
    }
    if (!readable) throw new Error('No readable text was found. This PDF may be scanned or blank. This reader does not run OCR; export a searchable PDF or attach a text copy.');
    if (noText.length) warnings.push(`Pages ${noText.join(', ')} contain no embedded body text and may be blank or scanned. OCR was not run; attach a searchable PDF to include scanned content.`);
    warnings.push('PDF text was extracted locally. Images and scanned content are not included; reading order may differ from the page layout.');
  } else {
    text = await textFor(ast.content);
    if (auxiliary.length) {
      const extra = await textFor(auxiliary);
      if (extra.trim()) text = checkLength(`${text}\n\n=== Document headers and footers ===\n${extra}`);
    }
    warnings.push('Text was extracted from the document. Images, layout, and embedded objects are not included.');
  }
  parentPort.postMessage({ text, warnings: [...new Set(warnings)], ...(pages ? { pages } : {}) });
} catch (error) {
  const message = error?.code === 'PASSWORD_REQUIRED' || error?.code === 'PASSWORD_INCORRECT'
    ? 'Password-protected documents are not supported. Choose an unlocked copy.'
    : error?.message || String(error);
  parentPort.postMessage({ error: message });
}
