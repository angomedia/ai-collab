import { parentPort, workerData } from 'node:worker_threads';
import ExcelJS from 'exceljs';

try {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workerData.filename);
  const sections = [];
  const sheets = [];
  const warnings = new Set(['Spreadsheet cells are provided with addresses. Formatting, charts, and images are not included.']);
  let total = 0;
  function append(text) {
    total += text.length + 1;
    if (total > workerData.maxChars) throw new Error('This workbook contains more than 200,000 characters. Split it into smaller files; no text was attached.');
    sections.push(text);
  }
  function display(value) {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
      if (value.hyperlink) return `${value.text || value.hyperlink} [link: ${value.hyperlink}]`;
      if (value.error) return value.error;
    }
    return String(value);
  }
  for (const sheet of workbook.worksheets) {
    const metadata = { name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount, state: sheet.state || 'visible' };
    sheets.push(metadata);
    append(`=== Sheet: ${JSON.stringify(sheet.name)}${metadata.state !== 'visible' ? ` (${metadata.state})` : ''} ===`);
    let nonempty = 0;
    sheet.eachRow({ includeEmpty: false }, row => {
      row.eachCell({ includeEmpty: false }, cell => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const value = cell.value;
        if (value == null) return;
        let text;
        if (typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
          warnings.add('Formula cells show saved cached results, which may be stale. Formulas are not recalculated or executed.');
          const formula = cell.formula || value.formula || `[shared formula ${value.sharedFormula}]`;
          const result = Object.hasOwn(value, 'result') && value.result !== undefined ? JSON.stringify(display(value.result)) : '[no cached result]';
          if (result === '[no cached result]') warnings.add('Some formula cells have no cached result; only their formulas are available.');
          text = `${cell.address}: formula ${JSON.stringify(formula)}; saved result ${result}`;
        } else text = `${cell.address}: ${JSON.stringify(display(value))}`;
        append(text);
        nonempty++;
      });
    });
    if (!nonempty) append('[Empty sheet]');
    append('');
  }
  if (!sheets.length || !workbook.worksheets.some(sheet => sheet.actualRowCount > 0)) throw new Error('No readable cell values were found in this workbook.');
  parentPort.postMessage({ text: sections.join('\n'), warnings: [...warnings], sheets });
} catch (error) { parentPort.postMessage({ error: error.message || 'This workbook could not be read.' }); }
