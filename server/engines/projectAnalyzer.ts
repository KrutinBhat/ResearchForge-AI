import JSZip from 'jszip';
import path from 'node:path';
import { validateFileSignature } from './documentParser';

export interface ExtractedProjectAnalysis {
  projectName: string;
  languages: string[];
  fileCount: number;
  totalLines: number;
  frameworks: string[];
  dependencies: string[];
  architecture: {
    backend: string[];
    frontend: string[];
    database: string[];
    tests: string[];
    configs: string[];
  };
  endpoints: Array<{ method: string; path: string; file: string }>;
  models: Array<{ name: string; type: string; file: string; details: string }>;
  algorithms: string[];
  databases: Array<{ table: string; columns: string[]; file: string }>;
  evaluationEvidence: Array<{ source: string; metrics: Record<string, number | string> }>;
  datasetsDetected: string[];
  reproducibilityNotes: string[];
  securityWarnings: string[];
}

export type CrossCheckStatus = 'Confirmed' | 'Possible' | 'Unsupported' | 'Unable to verify';

export interface PaperCodeCrossCheckFinding {
  id: string;
  category: 'Model Alignment' | 'Metric & Evidence' | 'Architecture Consistency' | 'Dataset & Reproducibility';
  status: CrossCheckStatus;
  claimExcerpt: string;
  codeEvidence: string;
  explanation: string;
}

const MAX_FILES = 450;
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

const CODE_EXTENSIONS: Record<string, string> = {
  '.py': 'Python',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.java': 'Java',
  '.c': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.h': 'C/C++ Header',
  '.sql': 'SQL',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.toml': 'TOML',
};

export function isSafeArchivePath(entryPath: string): boolean {
  if (!entryPath || entryPath.includes('\0')) return false;
  if (entryPath.startsWith('/') || entryPath.startsWith('\\') || /^[a-zA-Z]:/.test(entryPath)) return false;
  const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'));
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '.') return false;
  return true;
}

export function validatePublicGithubUrl(repoUrl: string): { owner: string; repo: string } {
  const cleaned = (repoUrl || '').trim();
  const match = cleaned.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) {
    throw new Error('Only public HTTPS GitHub URLs of the form https://github.com/owner/repo are allowed.');
  }
  return { owner: match[1], repo: match[2] };
}

export function analyzeFileSet(
  projectName: string,
  files: Array<{ path: string; content: string }>,
  securityWarnings: string[] = []
): ExtractedProjectAnalysis {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const dependencies = new Set<string>();
  const backend: string[] = [];
  const frontend: string[] = [];
  const database: string[] = [];
  const tests: string[] = [];
  const configs: string[] = [];
  const endpoints: Array<{ method: string; path: string; file: string }> = [];
  const models: Array<{ name: string; type: string; file: string; details: string }> = [];
  const algorithms = new Set<string>();
  const databases: Array<{ table: string; columns: string[]; file: string }> = [];
  const evaluationEvidence: Array<{ source: string; metrics: Record<string, number | string> }> = [];
  const datasetsDetected = new Set<string>();
  const reproducibilityNotes: string[] = [];
  let totalLines = 0;

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    const lang = CODE_EXTENSIONS[ext];
    if (lang && !['JSON', 'YAML', 'Markdown', 'TOML'].includes(lang)) {
      languages.add(lang);
    }
    const lines = file.content.split('\n');
    totalLines += lines.length;
    const lowerPath = file.path.toLowerCase();

    if (/(test|spec)\b/i.test(lowerPath)) tests.push(file.path);
    else if (ext === '.sql' || /schema|migration|models\.py|entities\.py/i.test(lowerPath)) database.push(file.path);
    else if (/\.(tsx|jsx)$|components\/|pages\/|frontend\//i.test(lowerPath)) frontend.push(file.path);
    else if (/(config|\.ya?ml|\.toml|requirements\.txt|package\.json|dockerfile)/i.test(lowerPath)) configs.push(file.path);
    else if (['.py', '.ts', '.js', '.java', '.c', '.cpp'].includes(ext)) backend.push(file.path);

    if (lowerPath.endsWith('requirements.txt')) {
      for (const line of lines) {
        const clean = line.split('#')[0].trim();
        if (clean) {
          dependencies.add(clean);
          if (/torch/i.test(clean)) frameworks.add('PyTorch');
          if (/tensorflow|keras/i.test(clean)) frameworks.add('TensorFlow');
          if (/scikit-learn|sklearn/i.test(clean)) frameworks.add('Scikit-learn');
          if (/fastapi/i.test(clean)) frameworks.add('FastAPI');
          if (/transformers/i.test(clean)) frameworks.add('Hugging Face Transformers');
          if (/sentence-transformers/i.test(clean)) frameworks.add('Sentence Transformers');
          if (/celery/i.test(clean)) frameworks.add('Celery');
          if (/sqlalchemy/i.test(clean)) frameworks.add('SQLAlchemy');
        }
      }
      reproducibilityNotes.push(`Pinned Python dependencies found in ${file.path}`);
    }

    if (lowerPath.endsWith('package.json')) {
      try {
        const pkg = JSON.parse(file.content);
        const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const [k, v] of Object.entries(allDeps)) {
          dependencies.add(`${k}@${v}`);
          if (k === 'react') frameworks.add('React');
          if (k === 'express') frameworks.add('Express');
          if (k === 'next') frameworks.add('Next.js');
          if (k === '@google/genai') frameworks.add('Google GenAI SDK');
          if (k === 'drizzle-orm') frameworks.add('Drizzle ORM');
        }
      } catch {
        // ignore invalid JSON
      }
    }

    const routeRegex =
      /(?:@(?:app|router)\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']|(?:app|router)\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']|@(?:Get|Post|Put|Delete)Mapping\(\s*["']([^"']+)["'])/gi;
    for (const m of file.content.matchAll(routeRegex)) {
      const method = (m[1] || m[3] || 'GET').toUpperCase();
      const routePath = m[2] || m[4] || m[5];
      if (routePath) endpoints.push({ method, path: routePath, file: file.path });
    }

    const sqlTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*?)\);/gi;
    for (const m of file.content.matchAll(sqlTableRegex)) {
      const table = m[1];
      const cols = m[2]
        .split(',')
        .map((c) => c.trim().split(/\s+/)[0])
        .filter((c) => c && !/^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK)$/i.test(c));
      databases.push({ table, columns: cols.slice(0, 12), file: file.path });
    }

    // Drizzle pgTable extraction
    const pgTableRegex = /pgTable\(\s*['"]([a-zA-Z0-9_]+)['"]/g;
    for (const m of file.content.matchAll(pgTableRegex)) {
      databases.push({ table: m[1], columns: ['Drizzle PostgreSQL schema'], file: file.path });
    }

    const classMatch = file.content.matchAll(
      /class\s+([A-Za-z0-9_]+)\s*\(([^)]*(?:nn\.Module|BaseEstimator|Model|Classifier|Regressor|Base)[^)]*)\)/g
    );
    for (const m of classMatch) {
      models.push({
        name: m[1],
        type: m[2].trim(),
        file: file.path,
        details: `Static class definition extending ${m[2].trim()}`,
      });
    }

    const sklearnModels = [
      'RandomForestClassifier',
      'XGBClassifier',
      'LogisticRegression',
      'SVC',
      'KMeans',
      'TfidfVectorizer',
      'SentenceTransformer',
      'ResNet',
      'BERT',
      'LSTM',
      'Transformer',
    ];
    for (const mod of sklearnModels) {
      if (file.content.includes(mod)) {
        models.push({ name: mod, type: 'Detected Library Model', file: file.path, details: `Referenced in ${file.path}` });
      }
    }

    if (/random_state\s*=|manual_seed|np\.random\.seed|seed\s*[:=]\s*\d+/i.test(file.content)) {
      reproducibilityNotes.push(`Deterministic random seed configured in ${file.path}`);
    }
    if (/cosine_similarity|tf-?idf|bm25|levenshtein|fedavg|butterworth|attention|gradient/i.test(file.content)) {
      const algHits =
        file.content.match(/\b(cosine_similarity|tfidf|bm25|fedavg|butterworth|dijkstra|kmeans|svm|backpropagation|adamw?)\b/gi) ?? [];
      for (const a of algHits) algorithms.add(a);
    }

    const datasetHits =
      file.content.match(/\b(MIT-BIH|MNIST|CIFAR-10|ImageNet|IMDb|SQuAD|FEVER|BEIR|PubMed|MIMIC-III)\b/gi) ?? [];
    for (const d of datasetHits) datasetsDetected.add(`${d} (${file.path})`);

    if (ext === '.json' && /(eval|metric|result|score|benchmark)/i.test(lowerPath)) {
      try {
        const parsed = JSON.parse(file.content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const flat: Record<string, number | string> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'number' || typeof v === 'string') flat[k] = v;
          }
          if (Object.keys(flat).length > 0) {
            evaluationEvidence.push({ source: file.path, metrics: flat });
          }
        }
      } catch {
        // ignore invalid json
      }
    }
  }

  return {
    projectName,
    languages: Array.from(languages),
    fileCount: files.length,
    totalLines,
    frameworks: Array.from(frameworks),
    dependencies: Array.from(dependencies).slice(0, 40),
    architecture: {
      backend: backend.slice(0, 25),
      frontend: frontend.slice(0, 25),
      database: database.slice(0, 15),
      tests: tests.slice(0, 15),
      configs: configs.slice(0, 15),
    },
    endpoints: endpoints.slice(0, 30),
    models: Array.from(new Map(models.map((m) => [`${m.name}:${m.file}`, m])).values()),
    algorithms: Array.from(algorithms),
    databases,
    evaluationEvidence,
    datasetsDetected: Array.from(datasetsDetected),
    reproducibilityNotes: Array.from(new Set(reproducibilityNotes)),
    securityWarnings,
  };
}

export async function analyzeZipArchive(buffer: Buffer, archiveName: string): Promise<ExtractedProjectAnalysis> {
  validateFileSignature(buffer, archiveName, 'zip');
  const zip = await JSZip.loadAsync(buffer);
  const files: Array<{ path: string; content: string }> = [];
  const securityWarnings: string[] = [];
  let totalBytes = 0;

  const entries = Object.values(zip.files);
  if (entries.length > MAX_FILES) {
    securityWarnings.push(`Archive contains ${entries.length} entries; static analysis capped at first ${MAX_FILES} source files.`);
  }

  for (const entry of entries.slice(0, MAX_FILES)) {
    if (entry.dir) continue;
    if (!isSafeArchivePath(entry.name)) {
      securityWarnings.push(`Blocked unsafe path traversal entry: ${entry.name}`);
      continue;
    }
    if (/node_modules\/|\.git\/|__pycache__\/|\.venv\/|dist\/|build\//.test(entry.name)) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    const base = path.basename(entry.name).toLowerCase();
    if (!CODE_EXTENSIONS[ext] && base !== 'requirements.txt' && base !== 'dockerfile') {
      continue;
    }
    const content = await entry.async('string');
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      securityWarnings.push('Uncompressed text extraction stopped at 25 MB safety boundary.');
      break;
    }
    files.push({ path: entry.name, content });
  }

  return analyzeFileSet(archiveName.replace(/\.zip$/i, ''), files, securityWarnings);
}

export async function analyzeGithubRepository(repoUrl: string): Promise<ExtractedProjectAnalysis> {
  const { owner, repo } = validatePublicGithubUrl(repoUrl);

  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, {
    headers: { 'User-Agent': 'ResearchForgeAI/1.1', Accept: 'application/vnd.github.v3+json' },
  });
  if (!treeRes.ok) {
    throw new Error(`Unable to read public GitHub repository (${treeRes.status}). Ensure the repository is public.`);
  }
  const treeData = (await treeRes.json()) as { tree?: Array<{ path: string; type: string; size?: number }> };
  const candidateFiles = (treeData.tree ?? [])
    .filter((f) => f.type === 'blob' && (f.size ?? 0) < 120_000)
    .filter((f) => {
      const ext = path.extname(f.path).toLowerCase();
      const base = path.basename(f.path).toLowerCase();
      return Boolean(CODE_EXTENSIONS[ext] || base === 'requirements.txt');
    })
    .slice(0, 35);

  const fetched: Array<{ path: string; content: string }> = [];
  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { 'User-Agent': 'ResearchForgeAI/1.1' },
  });
  const meta = metaRes.ok ? ((await metaRes.json()) as { default_branch?: string }) : {};
  const branch = meta.default_branch ?? 'main';

  await Promise.all(
    candidateFiles.map(async (f) => {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${f.path}`);
        if (r.ok) {
          fetched.push({ path: f.path, content: await r.text() });
        }
      } catch {
        // skip individual file failure
      }
    })
  );

  return analyzeFileSet(`${owner}/${repo}`, fetched);
}

export function crossCheckPaperAgainstCode(
  paperText: string,
  analysis: ExtractedProjectAnalysis
): PaperCodeCrossCheckFinding[] {
  const findings: PaperCodeCrossCheckFinding[] = [];
  const paperLower = paperText.toLowerCase();

  const modelKeywords = [
    'Transformer',
    'BERT',
    'LSTM',
    'ResNet',
    'XGBoost',
    'RandomForest',
    'SVM',
    'CNN',
    'FedAvg',
    'Residual1DCNN',
    'GNN',
    'Diffusion',
  ];
  const codeBlob = JSON.stringify(analysis).toLowerCase();

  for (const kw of modelKeywords) {
    const mentionedInPaper = new RegExp(`\\b${kw}\\b`, 'i').test(paperText);
    if (mentionedInPaper) {
      const exactModel = analysis.models.some((m) => m.name.toLowerCase().includes(kw.toLowerCase()));
      const inBlob = codeBlob.includes(kw.toLowerCase());
      const status: CrossCheckStatus = exactModel
        ? 'Confirmed'
        : inBlob
        ? 'Possible'
        : analysis.fileCount === 0
        ? 'Unable to verify'
        : 'Unsupported';
      findings.push({
        id: `chk_model_${kw}`,
        category: 'Model Alignment',
        status,
        claimExcerpt: `Manuscript references "${kw}" architecture/algorithm.`,
        codeEvidence: exactModel
          ? `Confirmed in extracted model classes (${analysis.models.map((m) => m.name).join(', ')}).`
          : inBlob
          ? `Keyword appears in project dependencies/text, though no dedicated class definition matched "${kw}".`
          : `No "${kw}" definition or import detected in analyzed source files.`,
        explanation:
          status === 'Confirmed'
            ? `Implementation evidence directly confirms ${kw}.`
            : status === 'Possible'
            ? `Indirect framework reference exists; confirm explicit layer/model instantiation.`
            : status === 'Unable to verify'
            ? `No source files were available in repository snapshot to inspect ${kw}.`
            : `Potential code-to-paper discrepancy: "${kw}" is described in the paper but absent from static repository extraction.`,
      });
    }
  }

  const metricClaims = Array.from(
    paperText.matchAll(/(?:accuracy|f1(?:-score)?|auroc|precision|recall)\s+(?:of|=|:)?\s*(\d{1,3}(?:\.\d+)?%?)/gi)
  );
  const evalStrings = JSON.stringify(analysis.evaluationEvidence);
  for (let i = 0; i < Math.min(metricClaims.length, 6); i++) {
    const val = metricClaims[i][1];
    const numericClean = val.replace('%', '');
    const inEval =
      evalStrings.includes(numericClean) ||
      (Number(numericClean) > 1 && evalStrings.includes((Number(numericClean) / 100).toFixed(3)));
    const status: CrossCheckStatus = inEval
      ? 'Confirmed'
      : analysis.evaluationEvidence.length > 0
      ? 'Unsupported'
      : 'Unable to verify';
    findings.push({
      id: `chk_metric_${i}`,
      category: 'Metric & Evidence',
      status,
      claimExcerpt: metricClaims[i][0],
      codeEvidence: inEval
        ? `Matched value in ${analysis.evaluationEvidence[0]?.source ?? 'evaluation artifact'}.`
        : analysis.evaluationEvidence.length > 0
        ? `Evaluation logs contain ${evalStrings}, which does not match "${val}".`
        : 'No structured JSON evaluation output file found in repository.',
      explanation: inEval
        ? 'Reported metric is directly substantiated by repository evaluation logs.'
        : analysis.evaluationEvidence.length > 0
        ? 'Reported metric disagrees with repository evaluation logs.'
        : 'Unable to verify reported metric because no evaluation log JSON was uploaded with source code.',
    });
  }

  if (/(fastapi|express|rest api|endpoint|postgresql|sql|database)/i.test(paperLower)) {
    const hasApiOrDb = analysis.endpoints.length > 0 || analysis.databases.length > 0;
    const status: CrossCheckStatus = hasApiOrDb
      ? 'Confirmed'
      : analysis.architecture.backend.length > 0
      ? 'Possible'
      : 'Unable to verify';
    findings.push({
      id: 'chk_arch_api',
      category: 'Architecture Consistency',
      status,
      claimExcerpt: 'Manuscript describes backend API endpoints or relational database persistence.',
      codeEvidence: hasApiOrDb
        ? `Extracted ${analysis.endpoints.length} route(s) and ${analysis.databases.length} SQL/ORM schema table(s).`
        : 'No API route decorators or SQL CREATE TABLE definitions identified in scanned files.',
      explanation: hasApiOrDb
        ? 'System architecture claims match extracted backend routes and/or schema definitions.'
        : 'Confirm backend entry points and SQL schemas are included in the repository archive.',
    });
  }

  const reproStatus: CrossCheckStatus =
    analysis.reproducibilityNotes.length > 0 && analysis.architecture.tests.length > 0
      ? 'Confirmed'
      : analysis.reproducibilityNotes.length > 0 || analysis.architecture.tests.length > 0
      ? 'Possible'
      : 'Unable to verify';
  findings.push({
    id: 'chk_repro',
    category: 'Dataset & Reproducibility',
    status: reproStatus,
    claimExcerpt: 'Experimental reproducibility and automated verification.',
    codeEvidence: `Tests: ${analysis.architecture.tests.length} file(s); Reproducibility markers: ${analysis.reproducibilityNotes.length}; Datasets: ${analysis.datasetsDetected.join(', ') || 'None explicitly detected'}.`,
    explanation:
      reproStatus === 'Confirmed'
        ? 'Automated test files and dependency/seed artifacts are present.'
        : 'Partial or missing automated test scripts / explicit random seed configuration.',
  });

  return findings;
}
