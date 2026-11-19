import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  chunkDocumentText,
  evaluatePdfPageOcrPlan,
  extractEquations,
  parseRawText,
  stripLatexMarkup,
  validateFileSignature,
} from './documentParser';
import { analyzeTextSimilarity, BUILTIN_REFERENCE_CORPUS } from './similarityEngine';
import { analyzeWritingPatterns, evaluateExperimentalClassifier } from './writingAnalyzer';
import {
  checkClaimToSourceRelevance,
  escapeBibtexValue,
  evaluateBibtexEntryAgainstCandidate,
  exportBibtexCollection,
  generateCitationKey,
  parseBibtexEntries,
  validateBibtexSyntax,
} from './citationEngine';
import {
  analyzeFileSet,
  isSafeArchivePath,
  validatePublicGithubUrl,
  crossCheckPaperAgainstCode,
} from './projectAnalyzer';
import {
  evaluateResearchQuality,
  buildIntegrityAudit,
  formatIntegrityAuditMarkdown,
} from './qualityAndAuditEngine';
import { validateRefinementPreservation } from './geminiService';
import { generateDocxBuffer, generatePdfBuffer } from './exportEngine';

test('validateFileSignature blocks dangerous headers and mismatched extensions', () => {
  assert.throws(() => validateFileSignature(Buffer.from('MZ\x90\x00payload'), 'paper.pdf', 'pdf'));
  assert.throws(() => validateFileSignature(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]), 'paper.txt', 'txt'));
  assert.throws(() => validateFileSignature(Buffer.from('plain text masquerading'), 'fake.pdf', 'pdf'));
  assert.throws(() => validateFileSignature(Buffer.from([0x61, 0x00, 0x62]), 'null.txt', 'txt'));

  assert.equal(validateFileSignature(Buffer.from('%PDF-1.7 body'), 'real.pdf', 'pdf'), 'pdf');
  assert.equal(validateFileSignature(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]), 'repo.zip', 'zip'), 'zip');
});

test('documentParser segments sections, tables, figures, equations, and chunks cleanly', () => {
  const sample = `Abstract
We evaluate federated learning with $w_{t+1} = \\sum w_k$ on ECG signals [1], [2].
Table 1: Cross-node throughput comparison.

I. Introduction
Prior models rely on centralized data (Smith, 2022).
Figure 1: Federated topology overview.

References
[1] B. McMahan et al., Federated Learning, 2017.`;

  const parsed = parseRawText(sample, 'txt');
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].heading, 'Abstract');
  assert.equal(parsed.references.length, 1);
  assert.ok(parsed.equationsFound.some((e) => e.includes('w_{t+1}')));
  assert.ok(parsed.citationsFound.includes('[1]'));
  assert.ok(parsed.citationsFound.includes('(Smith, 2022)'));
  assert.ok(parsed.tablesFound.length >= 1);
  assert.ok(parsed.figuresFound.length >= 1);

  const para = Array(65).fill('token').join(' ');
  const chunks = chunkDocumentText(`${para}\n\n${para}\n\n${para}`, 100);
  assert.equal(chunks.length, 3);
});

test('stripLatexMarkup preserves math and section headings', () => {
  const tex = `\\documentclass{article}\\begin{document}\\section{Methodology}Loss is $L = x^2$ per \\cite{ref1}.\\end{document}`;
  const out = stripLatexMarkup(tex);
  assert.ok(out.includes('Methodology'));
  assert.ok(out.includes('$L = x^2$'));
  assert.ok(out.includes('[ref1]'));
});

test('similarityEngine detects exact uncited overlap, near match, and paragraph chunks', () => {
  const text =
    'Modern mobile devices have access to a wealth of data suitable for learning models, which in turn can greatly improve the user experience on the device.\n\n' +
    'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms [2].';
  const res = analyzeTextSimilarity(text, BUILTIN_REFERENCE_CORPUS, 0);
  assert.ok(res.overallSimilarityPercent > 30);
  assert.ok(res.uncitedFlagCount >= 1);
  assert.ok(res.matches.some((m) => m.category === 'Potentially Uncited Passage'));
  assert.ok(res.corpusCoverage.indexedChunks >= 3);
});

test('writingAnalyzer computes V1.1 stylometrics and 24-excerpt 6-topic leave-one-topic-out benchmark', () => {
  const sample =
    'Furthermore, modern systems process large datasets efficiently. Moreover, deep architectures improve precision. Consequently, latency decreases substantially. Additionally, future research remains promising.';
  const res = analyzeWritingPatterns(sample);
  assert.ok(res.metrics.transitionDensityPer100Words > 3);
  assert.ok(res.metrics.estimatedPerplexityProxy > 0);
  assert.ok(res.metrics.mattr50 > 0 && res.metrics.mattr50 <= 1);
  assert.ok(res.metrics.shannonEntropyBits > 0);
  assert.equal(typeof res.metrics.zipfSlope, 'number');

  const bench = evaluateExperimentalClassifier();
  assert.equal(bench.sampleCount, 24);
  assert.ok(bench.f1Score >= 0 && bench.f1Score <= 1);
  assert.ok(bench.falsePositiveRate >= 0 && bench.falsePositiveRate <= 1);
});

test('citationEngine separates support vs opposing polarity contradictions', () => {
  const supported = checkClaimToSourceRelevance(
    'Transformer attention mechanisms significantly improve machine translation quality across datasets',
    'The Transformer architecture relies on self attention mechanisms and improves machine translation quality across benchmark datasets.'
  );
  assert.equal(supported.claimSupportStatus, 'Claim supported');

  const contradicted = checkClaimToSourceRelevance(
    'Sparse pruning improves model accuracy across federated edge workloads',
    'Sparse pruning degrades model accuracy and underperforms on federated edge workloads.'
  );
  assert.equal(contradicted.claimSupportStatus, 'Claim contradicted');
});

test('projectAnalyzer blocks SSRF/zip-slip, parses Drizzle tables, and produces 4-state cross-checks', () => {
  assert.equal(isSafeArchivePath('../../etc/passwd'), false);
  assert.equal(isSafeArchivePath('/etc/passwd'), false);
  assert.equal(isSafeArchivePath('src/models/resnet.py'), true);

  assert.throws(() => validatePublicGithubUrl('http://127.0.0.1:8080/org/repo'));
  assert.throws(() => validatePublicGithubUrl('https://gitlab.com/org/repo'));
  assert.deepEqual(validatePublicGithubUrl('https://github.com/facebookresearch/faiss'), {
    owner: 'facebookresearch',
    repo: 'faiss',
  });

  const analysis = analyzeFileSet('test-repo', [
    { path: 'requirements.txt', content: 'torch==2.3.0\nfastapi==0.111.0\n' },
    { path: 'app/model.py', content: 'class ECGNet(nn.Module):\n  pass\n# random_state=42' },
    { path: 'src/db/schema.ts', content: "export const metrics = pgTable('eval_metrics', { id: serial('id') });" },
    { path: 'eval/results.json', content: '{"macro_f1": 0.91}' },
  ]);
  assert.ok(analysis.languages.includes('Python'));
  assert.ok(analysis.models.some((m) => m.name === 'ECGNet'));
  assert.ok(analysis.databases.some((d) => d.table === 'eval_metrics'));

  const findings = crossCheckPaperAgainstCode(
    'We train an ECGNet and XGBoost classifier with PostgreSQL persistence achieving accuracy of 99.4% on ECG signals.',
    analysis
  );
  assert.ok(findings.some((f) => f.status === 'Confirmed'));
  assert.ok(findings.some((f) => f.status === 'Unsupported'));
});

test('quality evaluator reports 13 dimensions and 6-pillar integrity audit exports Markdown', () => {
  const parsed = parseRawText(
    'Abstract\nThis paper solves arrhythmia detection using MIT-BIH dataset and F1 metric.\n\nConclusion\nDone.'
  );
  const quality = evaluateResearchQuality(parsed.rawText, parsed.sections, parsed.references);
  assert.equal(quality.dimensions.length, 13);
  assert.ok(quality.dimensions.every((d) => Boolean(d.why) && Boolean(d.location)));

  const audit = buildIntegrityAudit({ quality });
  assert.equal(audit.findings.length, 6);
  assert.equal(audit.counts.notEvaluated, 5);
  assert.equal(audit.overallStatus, 'Needs review');

  const md = formatIntegrityAuditMarkdown('Test Study', audit);
  assert.ok(md.includes('Integrity & Methodology Audit'));
  assert.ok(md.includes('Overall Classification'));
});

test('refinement preservation validator detects dropped citations, equations, numeric drift, and missing terms', () => {
  const orig = 'Given $E = mc^2$, Transformer throughput improves by 14% in [1].';
  const good = 'Assuming $E = mc^2$, Transformer throughput increases by 14% in [1].';
  const bad = 'Previous investigations claim 99% gains.';

  const vGood = validateRefinementPreservation(orig, good, 'Transformer');
  assert.equal(vGood.citationsPreserved, true);
  assert.equal(vGood.equationsPreserved, true);
  assert.equal(vGood.missingNumbers.length, 0);
  assert.equal(vGood.missingTerms.length, 0);

  const vBad = validateRefinementPreservation(orig, bad, 'Transformer');
  assert.equal(vBad.citationsPreserved, false);
  assert.equal(vBad.equationsPreserved, false);
  assert.ok(vBad.missingNumbers.includes('14%'));
  assert.ok(vBad.addedNumbers.includes('99%'));
  assert.ok(vBad.missingTerms.includes('Transformer'));
  assert.equal(vBad.numbersPreserved, false);
  assert.equal(vBad.termsPreserved, false);
});

test('exportEngine produces real two-column IEEE DOCX/PDF and single-column APA DOCX/PDF', async () => {
  const sections = [
    { id: 'abs', heading: 'Abstract', content: 'Grounded abstract summary.' },
    { id: 'intro', heading: 'I. Introduction', content: 'Grounded body paragraph.' },
  ];
  const refs = ['[1] J. Doe, Paper Title, 2024.'];

  const ieeeDocx = await generateDocxBuffer({ title: 'IEEE Study', sections, references: refs, style: 'IEEE' });
  const ieeeZip = await JSZip.loadAsync(ieeeDocx);
  const ieeeXml = await ieeeZip.file('word/document.xml')?.async('string');
  assert.ok(ieeeXml?.includes('<w:cols w:num="2"'));

  const apaDocx = await generateDocxBuffer({ title: 'APA Study', sections, references: refs, style: 'APA' });
  const apaZip = await JSZip.loadAsync(apaDocx);
  const apaXml = await apaZip.file('word/document.xml')?.async('string');
  assert.ok(apaXml && !apaXml.includes('<w:cols w:num="2"'));

  const ieeePdf = generatePdfBuffer({ title: 'IEEE Study', sections, references: refs, style: 'IEEE' });
  assert.equal(ieeePdf.subarray(0, 5).toString('utf8'), '%PDF-');
  assert.ok(ieeePdf.toString('latin1').includes('/Type /Page'));
  assert.ok(ieeePdf.toString('latin1').includes('IEEE Study'));

  const apaPdf = generatePdfBuffer({ title: 'APA Study', sections, references: refs, style: 'APA' });
  assert.equal(apaPdf.subarray(0, 5).toString('utf8'), '%PDF-');
  assert.ok(apaPdf.toString('latin1').includes('APA Study'));
});

test('auth security enforces Firebase aud/iss/exp/uid claims and blocks weak secrets or demo in production', async () => {
  const { validateFirebaseDecodedClaims, isDemoAllowed, getJwtSecret, requireAuth } = await import(
    '../../src/middleware/auth.ts'
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const pid = 'rf-test-proj';
  const validClaims = {
    uid: 'uid_123',
    sub: 'uid_123',
    aud: pid,
    iss: `https://securetoken.google.com/${pid}`,
    exp: nowSec + 600,
    email: 'author@uni.edu',
  };

  assert.equal(validateFirebaseDecodedClaims(validClaims, pid)?.uid, 'uid_123');
  assert.equal(validateFirebaseDecodedClaims({ ...validClaims, exp: nowSec - 10 }, pid), null);
  assert.equal(validateFirebaseDecodedClaims({ ...validClaims, aud: 'other-proj' }, pid), null);
  assert.equal(
    validateFirebaseDecodedClaims({ ...validClaims, iss: 'https://securetoken.google.com/other-proj' }, pid),
    null
  );
  assert.equal(validateFirebaseDecodedClaims({ ...validClaims, sub: 'different_uid' }, pid), null);

  const prevEnv = process.env.NODE_ENV;
  const prevJwt = process.env.JWT_SECRET;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(isDemoAllowed(), false);
    process.env.JWT_SECRET = 'short-secret';
    assert.throws(() => getJwtSecret());
    process.env.JWT_SECRET = 'change-me-still-insecure-even-if-long-enough-string';
    assert.throws(() => getJwtSecret());
    process.env.JWT_SECRET = '9f7e3c2a1b8d4e6f0a2c4e6813579bdf2468ace013579bdf';
    assert.equal(getJwtSecret().length >= 32, true);
  } finally {
    process.env.NODE_ENV = prevEnv;
    process.env.JWT_SECRET = prevJwt;
  }

  let statusCode = 0;
  let body: any = null;
  let nextCalled = false;
  const mockRes: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
  };
  await requireAuth({ headers: {} } as any, mockRes, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.ok(String(body?.error || '').includes('Unauthorized'));
});

test('pgvector 384-d embedding generator produces normalized unit vectors with cosine discrimination', async () => {
  const { computeNormalizedChunkVector384 } = await import('../../src/db/queries.ts');
  const v1 = computeNormalizedChunkVector384('Federated learning optimization over distributed edge neural networks');
  const v2 = computeNormalizedChunkVector384('Distributed edge neural networks trained using federated optimization');
  const v3 = computeNormalizedChunkVector384('Archaeological stratigraphy and ceramic pottery chronology');

  assert.equal(v1.length, 384);
  const norm = Math.sqrt(v1.reduce((acc, x) => acc + x * x, 0));
  assert.ok(Math.abs(norm - 1.0) < 0.01);

  const cosine = (a: number[], b: number[]) => a.reduce((acc, x, i) => acc + x * b[i], 0);
  assert.ok(cosine(v1, v2) > 0.7);
  assert.ok(cosine(v1, v3) < 0.25);
});

test('mixed PDF OCR planner detects sparse (<50 char) pages and enforces 30-page OCR cap', () => {
  const pageCharCounts = [120, ...Array(34).fill(3)];
  const plan = evaluatePdfPageOcrPlan(pageCharCounts);
  assert.equal(plan.digitalPageCount, 1);
  assert.equal(plan.isMixedPdf, true);
  assert.equal(plan.scannedPagesDetected.length, 34);
  assert.equal(plan.pagesToOcr.length, 30);
  assert.equal(plan.skippedPagesDueToLimit.length, 4);
  assert.equal(extractEquations('Loss is $L = a + b$.').length, 1);
});

test('BibTeX exporter escapes LaTeX, resolves key collisions, validates syntax, and defaults verified-only', () => {
  assert.ok(escapeBibtexValue('Security & Privacy 100%').includes('\\&'));
  assert.ok(escapeBibtexValue('Security & Privacy 100%').includes('\\%'));

  const keys = new Set<string>();
  assert.equal(generateCitationKey(['A. Vaswani'], 2017, 'Attention Is All You Need', keys), 'vaswani2017attention');
  assert.equal(generateCitationKey(['A. Vaswani'], 2017, 'Attention Is All You Need', keys), 'vaswani2017attentiona');

  const sampleCitations = [
    {
      id: 'cit_1',
      rawReference: '[1] A. Vaswani et al., "Attention Is All You Need," NeurIPS, 2017.',
      status: 'Verified',
      bibliographicStatus: 'Bibliographic metadata verified',
      verifiedMetadata: {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        year: 2017,
        venue: 'Advances in Neural Information Processing Systems',
        pages: '5998-6008',
        doi: '10.5555/3295222.3295349',
        entryType: 'inproceedings',
      },
    },
    {
      id: 'cit_2',
      rawReference: '[2] Missing Paper, 2099.',
      status: 'Unverified',
      bibliographicStatus: 'Verification unavailable',
      verifiedMetadata: null,
    },
  ];

  const verifiedOnly = exportBibtexCollection(sampleCitations, false);
  assert.equal(verifiedOnly.includedCount, 1);
  assert.equal(verifiedOnly.skippedCount, 1);
  assert.equal(verifiedOnly.validation.valid, true);
  assert.ok(verifiedOnly.bibtex.includes('@inproceedings{vaswani2017attention,'));

  const includeAll = exportBibtexCollection(sampleCitations, true);
  assert.equal(includeAll.includedCount, 2);
  assert.equal(includeAll.skippedCount, 0);
  assert.equal(includeAll.validation.valid, true);
  assert.ok(includeAll.bibtex.includes('% WARNING:'));

  assert.equal(validateBibtexSyntax('@article{bad,\n  title = {missing brace').valid, false);
});

test('Firebase SA resolver and ENABLE_DEMO_WORKSPACE=false guard enforce strict prod config', async () => {
  const { resolveServiceAccount } = await import('../../src/lib/firebase-admin.ts');
  const { isDemoAllowed } = await import('../../src/middleware/auth.ts');

  const sa = {
    type: 'service_account',
    project_id: 'rf-prod',
    client_email: 'admin@rf-prod.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n',
  };
  assert.equal((resolveServiceAccount(JSON.stringify(sa)) as Record<string, any> | null)?.project_id, 'rf-prod');
  const b64 = Buffer.from(JSON.stringify(sa), 'utf8').toString('base64');
  assert.equal((resolveServiceAccount(b64) as Record<string, any> | null)?.client_email, sa.client_email);
  const wrappedB64 = `"${b64.slice(0, 32)}\n  ${b64.slice(32)}"`;
  assert.equal((resolveServiceAccount(wrappedB64) as Record<string, any> | null)?.project_id, 'rf-prod');
  const doubleEscaped = JSON.stringify({ ...sa, private_key: 'lineA\\nlineB' });
  const parsedEsc = resolveServiceAccount(doubleEscaped) as Record<string, any> | null;
  assert.ok(parsedEsc?.privateKey || parsedEsc?.private_key);
  assert.ok(String(parsedEsc?.private_key || '').includes('\n'));
  assert.equal(resolveServiceAccount(''), null);

  const prevDemo = process.env.ENABLE_DEMO_WORKSPACE;
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_DEMO_WORKSPACE = 'false';
    assert.equal(isDemoAllowed(), false);
  } finally {
    process.env.ENABLE_DEMO_WORKSPACE = prevDemo;
    process.env.NODE_ENV = prevNodeEnv;
  }
});

test('BibTeX parser and Crossref discrepancy evaluator detect field mismatches', () => {
  const raw = `@inproceedings{he2016deep,
  author = {Kaiming He and Xiangyu Zhang and Shaoqing Ren and Jian Sun},
  title = {{Deep} Residual Learning for Image Recognition},
  booktitle = {CVPR},
  year = {2018},
  doi = {10.1109/CVPR.2016.90}
}`;
  const entries = parseBibtexEntries(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].citeKey, 'he2016deep');
  assert.equal(entries[0].title, 'Deep Residual Learning for Image Recognition');
  assert.equal(entries[0].authors.length, 4);

  const audited = evaluateBibtexEntryAgainstCandidate(entries[0], {
    provider: 'Crossref',
    title: 'Deep Residual Learning for Image Recognition',
    authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
    year: 2016,
    venue: 'Proceedings of CVPR',
    doi: '10.1109/CVPR.2016.90',
    url: 'https://doi.org/10.1109/CVPR.2016.90',
    entryType: 'inproceedings',
  });
  assert.equal(audited.status, 'Needs review');
  assert.equal(audited.yearMatched, false);
  assert.equal(audited.doiMatched, true);
  assert.equal(audited.authorMatched, true);
  assert.ok(audited.discrepancies.some((d) => d.field === 'year'));
});
