import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';

export interface ParsedSection {
  id: string;
  heading: string;
  content: string;
}

export interface ParsedDocument {
  format: string;
  rawText: string;
  sections: ParsedSection[];
  references: string[];
  citationsFound: string[];
  equationsFound: string[];
  tablesFound: string[];
  figuresFound: string[];
  wordCount: number;
  ocrRequired: boolean;
  pageCount?: number;
  scannedPagesDetected?: number[];
  isMixedPdf?: boolean;
  warnings: string[];
}

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'txt', 'md', 'rtf', 'tex', 'bib']);
export const MIN_DIGITAL_CHARS_PER_PAGE = 50;
export const MAX_OCR_PAGES = 30;

export function evaluatePdfPageOcrPlan(
  pageCharCounts: number[],
  threshold = MIN_DIGITAL_CHARS_PER_PAGE,
  maxOcrPages = MAX_OCR_PAGES
) {
  const scannedPagesDetected: number[] = [];
  pageCharCounts.forEach((len, idx) => {
    if (len < threshold) scannedPagesDetected.push(idx + 1);
  });
  const pagesToOcr = scannedPagesDetected.slice(0, maxOcrPages);
  const skippedPagesDueToLimit = scannedPagesDetected.slice(maxOcrPages);
  const digitalPageCount = pageCharCounts.length - scannedPagesDetected.length;
  return {
    scannedPagesDetected,
    pagesToOcr,
    skippedPagesDueToLimit,
    digitalPageCount,
    isMixedPdf: digitalPageCount > 0 && scannedPagesDetected.length > 0,
    thresholdChars: threshold,
    pageLimitApplied: maxOcrPages,
  };
}

const MAGIC_SIGNATURES: Record<string, Buffer[]> = {
  pdf: [Buffer.from('%PDF-')],
  docx: [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])],
  zip: [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])],
  doc: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  rtf: [Buffer.from('{\\rtf')],
};

const DANGEROUS_SIGNATURES: Array<{ sig: Buffer; label: string }> = [
  { sig: Buffer.from('MZ'), label: 'Windows executable payload' },
  { sig: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), label: 'ELF executable binary' },
  { sig: Buffer.from('#!/'), label: 'Shell script payload' },
  { sig: Buffer.from('<?php'), label: 'PHP script payload' },
];

export function validateFileSignature(buffer: Buffer, filename: string, expectedExt?: string): string {
  if (!buffer || buffer.length === 0) {
    throw new Error('Uploaded file is empty.');
  }
  for (const { sig, label } of DANGEROUS_SIGNATURES) {
    if (buffer.subarray(0, sig.length).equals(sig)) {
      throw new Error(`Rejected unsafe upload (${label}).`);
    }
  }
  const ext = (expectedExt || filename.split('.').pop() || '').toLowerCase().trim();
  const allowed = MAGIC_SIGNATURES[ext];
  if (allowed) {
    const matched = allowed.some((sig) => buffer.subarray(0, sig.length).equals(sig));
    if (!matched) {
      throw new Error(`File signature does not match declared .${ext} format.`);
    }
    return ext;
  }
  if (['txt', 'md', 'tex', 'bib', 'csv', 'json'].includes(ext)) {
    const sample = buffer.subarray(0, Math.min(4096, buffer.length));
    if (sample.includes(0)) {
      throw new Error(`Binary null bytes detected inside text .${ext} file.`);
    }
    return ext;
  }
  throw new Error(`Unsupported or unrecognized file extension '.${ext}'.`);
}

export function detectFormat(filename: string, mimeType?: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (SUPPORTED_EXTENSIONS.has(ext)) return ext;
  if (mimeType?.includes('pdf')) return 'pdf';
  if (mimeType?.includes('wordprocessingml')) return 'docx';
  if (mimeType?.includes('msword')) return 'doc';
  if (mimeType?.includes('rtf')) return 'rtf';
  if (mimeType?.includes('x-tex')) return 'tex';
  if (mimeType?.includes('bibtex')) return 'bib';
  return 'txt';
}

export function stripLatexMarkup(tex: string): string {
  const cleaned = tex
    .replace(/%.*$/gm, '')
    .replace(/\\documentclass[\s\S]*?\\begin\{document\}/g, '')
    .replace(/\\end\{document\}/g, '')
    .replace(/\\title\{([^}]*)\}/g, '$1\n')
    .replace(/\\author\{[^}]*\}/g, '')
    .replace(/\\maketitle/g, '')
    .replace(/\\(?:sub)*section\*?\{([^}]*)\}/g, '\n$1\n')
    .replace(/\\begin\{abstract\}/g, '\nAbstract\n')
    .replace(/\\end\{abstract\}/g, '\n')
    .replace(/\\begin\{thebibliography\}[\s\S]*?\\bibitem/g, '\nReferences\n\\bibitem')
    .replace(/\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}/g, '[$1] ')
    .replace(/\\end\{thebibliography\}/g, '')
    .replace(/\\textbf\{([^}]*)\}/g, '$1')
    .replace(/\\textit\{([^}]*)\}/g, '$1')
    .replace(/\\emph\{([^}]*)\}/g, '$1')
    .replace(/\\cite[pt]?\{([^}]*)\}/g, '[$1]')
    .replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

export function stripRtfMarkup(rtf: string): string {
  return rtf
    .replace(/\{\*?\\[^{}]+;\}/g, '')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\tab/g, '\t')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractEquations(text: string): string[] {
  const matches = new Set<string>();
  const displayRegex = /\$\$[\s\S]+?\$\$|\\begin\{equation\*?\}[\s\S]+?\\end\{equation\*?\}|\\\[[\s\S]+?\\\]/g;
  const inlineRegex = /\$[^$\n]{2,120}\$/g;

  for (const m of text.match(displayRegex) ?? []) {
    matches.add(m.trim());
  }
  for (const m of text.match(inlineRegex) ?? []) {
    matches.add(m.trim());
  }
  return Array.from(matches);
}

export function extractTablesAndFigures(text: string): { tablesFound: string[]; figuresFound: string[] } {
  const tablesFound = Array.from(new Set((text.match(/^(?:Table|TABLE)\s+[IVX\d]+[^\n]{0,120}/gm) ?? []).map((s) => s.trim())));
  const figuresFound = Array.from(new Set((text.match(/^(?:Fig\.|Figure|FIG\.)\s*[IVX\d]+[^\n]{0,120}/gm) ?? []).map((s) => s.trim())));
  return { tablesFound, figuresFound };
}

export function extractInTextCitations(text: string): string[] {
  const found = new Set<string>();
  const bracketNums = text.match(/\[\d+(?:\s*[-,]\s*\d+)*\]/g) ?? [];
  const authorYear = text.match(/\([A-Z][a-zA-Z-]+(?:\s+(?:et\s+al\.|&|and)\s+[A-Z][a-zA-Z-]+)?,\s*(?:19|20)\d{2}[a-z]?\)/g) ?? [];
  const latexCite = text.match(/\\cite[pt]?\{[^}]+\}/g) ?? [];

  for (const c of [...bracketNums, ...authorYear, ...latexCite]) {
    found.add(c.trim());
  }
  return Array.from(found);
}

const SECTION_HEADING_PATTERNS = [
  /^(?:[IVX]+\.\s+|\d+(?:\.\d+)*\.?\s+|#{1,3}\s+)?(abstract|keywords|index terms|introduction|related work|literature review|background|problem statement|methodology|proposed methodology|proposed approach|system architecture|architecture|experimental setup|implementation|experiments|results|results and discussion|evaluation|discussion|limitations|conclusion|conclusions|future work|future scope|acknowledgments?|references|bibliography)\s*:?$/i,
];

function isLikelyHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 90) return false;
  if (SECTION_HEADING_PATTERNS.some((p) => p.test(trimmed))) return true;
  if (/^#{1,3}\s+\S+/.test(trimmed)) return true;
  if (/^(?:[IVX]+\.|[1-9]\.)\s+[A-Z][A-Za-z0-9\s,&:-]{2,65}$/.test(trimmed) && !trimmed.endsWith('.')) {
    return true;
  }
  return false;
}

export function segmentSections(rawText: string): { sections: ParsedSection[]; references: string[] } {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const sections: ParsedSection[] = [];
  let currentHeading = 'Document Body';
  let currentBuffer: string[] = [];
  let refMode = false;
  const referenceLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (isLikelyHeading(trimmed)) {
      const cleanHeading = trimmed.replace(/^#{1,3}\s+/, '').replace(/:$/, '');
      if (currentBuffer.join('\n').trim()) {
        if (refMode) {
          referenceLines.push(...currentBuffer.map((l) => l.trim()).filter(Boolean));
        } else {
          sections.push({
            id: `sec_${sections.length + 1}`,
            heading: currentHeading,
            content: currentBuffer.join('\n').trim(),
          });
        }
      }
      currentHeading = cleanHeading;
      currentBuffer = [];
      refMode = /^(?:[IVX]+\.\s+|\d+\.\s+)?(references|bibliography)$/i.test(cleanHeading);
    } else {
      currentBuffer.push(line);
    }
  }

  if (currentBuffer.join('\n').trim()) {
    if (refMode) {
      referenceLines.push(...currentBuffer.map((l) => l.trim()).filter(Boolean));
    } else {
      sections.push({
        id: `sec_${sections.length + 1}`,
        heading: currentHeading,
        content: currentBuffer.join('\n').trim(),
      });
    }
  }

  const references: string[] = [];
  for (const line of referenceLines) {
    if (/^(\[\d+\]|\d+\.)\s+/.test(line) || references.length === 0) {
      references.push(line);
    } else {
      references[references.length - 1] += ` ${line}`;
    }
  }

  if (sections.length === 0 && rawText.trim()) {
    sections.push({
      id: 'sec_1',
      heading: 'Manuscript Content',
      content: rawText.trim(),
    });
  }

  return { sections, references };
}

export function chunkDocumentText(text: string, maxWords = 180): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let buf: string[] = [];
  let count = 0;

  for (const p of paragraphs) {
    const wc = p.split(/\s+/).filter(Boolean).length;
    if (count > 0 && count + wc > maxWords) {
      chunks.push(buf.join('\n\n'));
      buf = [p];
      count = wc;
    } else {
      buf.push(p);
      count += wc;
    }
  }
  if (buf.length > 0) chunks.push(buf.join('\n\n'));
  return chunks;
}

export async function parseDocumentBuffer(
  buffer: Buffer,
  filename: string,
  mimeType?: string
): Promise<ParsedDocument> {
  const format = detectFormat(filename, mimeType);
  validateFileSignature(buffer, filename, format);

  const warnings: string[] = [];
  let rawText = '';
  let ocrRequired = false;
  let pageCount = 0;
  let scannedPagesDetected: number[] = [];
  let isMixedPdf = false;

  if (format === 'pdf') {
    let pageTexts: string[] = [];
    try {
      const result = await extractPdfText(new Uint8Array(buffer), { mergePages: false });
      const rawResult = result.text;
      if (Array.isArray(rawResult)) {
        pageTexts = rawResult.map((p) => String(p ?? '').trim());
      } else {
        pageTexts = [String(rawResult ?? '').trim()];
      }
      pageCount = pageTexts.length;
      rawText = pageTexts.filter(Boolean).join('\n\n').trim();
    } catch (err: any) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('password') || msg.includes('encrypt')) {
        throw new Error('Encrypted/password-protected PDFs cannot be parsed without decryption.');
      }
      throw new Error(`Unable to parse PDF file: ${err?.message || 'corrupted structure'}`);
    }
    const plan = evaluatePdfPageOcrPlan(pageTexts.map((t) => t.length));
    scannedPagesDetected = plan.scannedPagesDetected;
    isMixedPdf = plan.isMixedPdf;
    if (scannedPagesDetected.length > 0) {
      ocrRequired = true;
      const previewPages = scannedPagesDetected.slice(0, 10).join(', ') + (scannedPagesDetected.length > 10 ? ', ...' : '');
      const capNotice =
        plan.skippedPagesDueToLimit.length > 0
          ? ` (OCR worker caps scans at ${MAX_OCR_PAGES} pages per PDF).`
          : '.';
      warnings.push(
        isMixedPdf
          ? `Mixed digital + scanned PDF detected: ${scannedPagesDetected.length} sparse/scanned page(s) [<${MIN_DIGITAL_CHARS_PER_PAGE} chars] (page ${previewPages}). Native Tesseract OCR runs in the FastAPI/Celery container${capNotice}`
          : `Scanned PDF detected across ${scannedPagesDetected.length} page(s) [<${MIN_DIGITAL_CHARS_PER_PAGE} chars]. Native Tesseract OCR runs in the FastAPI/Celery container${capNotice}`
      );
    }
  } else if (format === 'docx') {
    const res = await mammoth.extractRawText({ buffer });
    rawText = (res.value ?? '').trim();
    if (res.messages.length > 0) {
      warnings.push(...res.messages.map((m) => m.message));
    }
  } else if (format === 'doc') {
    const utf8 = buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
    rawText = utf8.replace(/\s{3,}/g, '\n').trim();
    warnings.push('Legacy binary .doc parsed via OLE text-stream extraction; converting to .docx or using the Python LibreOffice container yields full fidelity.');
  } else if (format === 'tex') {
    rawText = stripLatexMarkup(buffer.toString('utf8'));
  } else if (format === 'rtf') {
    rawText = stripRtfMarkup(buffer.toString('utf8'));
  } else {
    rawText = buffer.toString('utf8').trim();
  }

  const parsed = parseRawText(rawText, format, ocrRequired, warnings);
  if (format === 'pdf') {
    parsed.pageCount = pageCount;
    parsed.scannedPagesDetected = scannedPagesDetected;
    parsed.isMixedPdf = isMixedPdf;
  }
  return parsed;
}

export function parseRawText(
  rawText: string,
  format = 'txt',
  ocrRequired = false,
  warnings: string[] = []
): ParsedDocument {
  const { sections, references } = segmentSections(rawText);
  const citationsFound = extractInTextCitations(rawText);
  const equationsFound = extractEquations(rawText);
  const { tablesFound, figuresFound } = extractTablesAndFigures(rawText);
  const wordCount = rawText.split(/\s+/).filter(Boolean).length;

  return {
    format,
    rawText,
    sections,
    references,
    citationsFound,
    equationsFound,
    tablesFound,
    figuresFound,
    wordCount,
    ocrRequired,
    warnings,
  };
}
