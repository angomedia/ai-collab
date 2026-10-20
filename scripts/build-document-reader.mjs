import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function buildDocumentReader({ arch = process.arch, output = path.join(root, 'resources/document-reader') } = {}) {
  if (process.platform !== 'darwin') {
    console.log('Native PDFKit reader is macOS-only; this platform uses the portable document reader.');
    return null;
  }
  const targetArch = { arm64: 'arm64', x64: 'x86_64' }[arch];
  if (!targetArch) throw new Error(`Unsupported macOS document-reader architecture: ${arch}`);
  await mkdir(path.dirname(output), { recursive: true });
  await promisify(execFile)('/usr/bin/swiftc', [
    '-O', '-target', `${targetArch}-apple-macos13.0`,
    '-framework', 'PDFKit', '-framework', 'Vision', '-framework', 'AppKit',
    path.join(root, 'scripts/document-reader.swift'), '-o', output,
  ], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  console.log(`Built ${path.relative(root, output)} for ${arch} with PDFKit and on-device Vision OCR.`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  await buildDocumentReader({ arch: arg('--arch'), output: arg('--output') });
}
