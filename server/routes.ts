import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db, pool } from '../src/db/index.ts';
import { newId, getOrCreateFirebaseUser } from '../src/db/users.ts';
import {
  citationChecks,
  citations as citationsTable,
  documents,
  documentVersions,
  integrityAudits,
  projects,
  qualityEvaluations,
  refinementJobs,
  similarityReports,
  users,
  writingAnalyses,
} from '../src/db/schema.ts';
import {
  clearUserWorkspaceData,
  ensureDemoWorkspaceSeeded,
  getUserDashboardData,
  indexDocumentChunks,
  logActivity,
  queryPgvectorSimilarChunks,
} from '../src/db/queries.ts';
import {
  AuthRequest,
  isDemoAllowed,
  requireAuth,
  signSessionToken,
  validateFirebaseDecodedClaims,
} from '../src/middleware/auth.ts';
import { adminAuth } from '../src/lib/firebase-admin.ts';
import { parseDocumentBuffer, parseRawText, ParsedSection } from './engines/documentParser.ts';
import {
  analyzeTextSimilarity,
  BUILTIN_REFERENCE_CORPUS,
  CorpusDocument,
  fetchArxivRelatedAbstracts,
} from './engines/similarityEngine.ts';
import { analyzeWritingPatterns } from './engines/writingAnalyzer.ts';
import {
  checkClaimToSourceRelevance,
  exportBibtexCollection,
  verifyBibliography,
  verifyBibtexEntries,
} from './engines/citationEngine.ts';
import {
  analyzeGithubRepository,
  analyzeZipArchive,
  crossCheckPaperAgainstCode,
  ExtractedProjectAnalysis,
} from './engines/projectAnalyzer.ts';
import {
  buildIntegrityAudit,
  evaluateResearchQuality,
  formatIntegrityAuditMarkdown,
  generateOptionalReviewerCritique,
} from './engines/qualityAndAuditEngine.ts';
import { generateResearchPaper, refineAcademicText, RefinementMode } from './engines/geminiService.ts';
import { generateDocxBuffer, generatePdfBuffer } from './engines/exportEngine.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const rateWindows = new Map<string, { count: number; resetAt: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || 'local';
  const now = Date.now();
  const entry = rateWindows.get(ip);
  if (!entry || now > entry.resetAt) {
    rateWindows.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  entry.count++;
  if (entry.count > 240) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait before issuing more requests.' });
  }
  return next();
}

const authRateWindows = new Map<string, { count: number; resetAt: number }>();
function authRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || 'local';
  const now = Date.now();
  const limit = Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE || 30);
  const entry = authRateWindows.get(ip);
  if (!entry || now > entry.resetAt) {
    authRateWindows.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  entry.count++;
  if (entry.count > limit) {
    return res.status(429).json({ error: 'Authentication rate limit exceeded. Try again in a minute.' });
  }
  return next();
}

function isDemoEnabled(): boolean {
  return isDemoAllowed();
}

function executeRefinementJobInBackground(
  jobId: string,
  userId: string,
  docId: string,
  docTitle: string,
  allSections: ParsedSection[],
  targetSections: ParsedSection[],
  mode: RefinementMode,
  scope: string,
  preserveTerms: string,
  engineMode: 'gemini' | 'local',
  paragraphTarget?: { sectionId: string; originalParagraph: string }
) {
  (async () => {
    try {
      await db.update(refinementJobs).set({ status: 'processing', progress: 12 }).where(eq(refinementJobs.id, jobId));

      const refinedMap = new Map<string, { section: ParsedSection; validation: any; engineUsed: string }>();

      for (let i = 0; i < targetSections.length; i++) {
        // Check cancellation flag between sections
        const [jobRow] = await db
          .select({ cancelled: refinementJobs.cancelled })
          .from(refinementJobs)
          .where(eq(refinementJobs.id, jobId))
          .limit(1);
        if (jobRow?.cancelled) {
          await db
            .update(refinementJobs)
            .set({ status: 'cancelled', errorMessage: 'Cancelled by researcher.' })
            .where(eq(refinementJobs.id, jobId));
          return;
        }

        const sec = targetSections[i];
        if (scope === 'selected_paragraphs' && paragraphTarget && paragraphTarget.sectionId === sec.id) {
          const out = await refineAcademicText({
            heading: `${sec.heading} (Excerpt)`,
            text: paragraphTarget.originalParagraph,
            mode,
            preserveTerms,
            engineMode,
          });
          const merged = sec.content.includes(paragraphTarget.originalParagraph)
            ? sec.content.replace(paragraphTarget.originalParagraph, out.refinedText)
            : out.refinedText;
          refinedMap.set(sec.id, {
            section: { id: sec.id, heading: sec.heading, content: merged },
            validation: out.validation,
            engineUsed: out.engineUsed,
          });
        } else {
          const out = await refineAcademicText({
            heading: sec.heading,
            text: sec.content,
            mode,
            preserveTerms,
            engineMode,
          });
          refinedMap.set(sec.id, {
            section: { id: sec.id, heading: sec.heading, content: out.refinedText },
            validation: out.validation,
            engineUsed: out.engineUsed,
          });
        }

        const pct = Math.min(92, Math.round(((i + 1) / targetSections.length) * 80) + 12);
        await db.update(refinementJobs).set({ progress: pct }).where(eq(refinementJobs.id, jobId));
      }

      const finalSections = allSections.map((s) => refinedMap.get(s.id)?.section ?? s);
      const origCombined = targetSections.map((s) => s.content).join('\n\n');
      const refCombined = targetSections.map((s) => refinedMap.get(s.id)?.section.content ?? s.content).join('\n\n');
      const preMetrics = analyzeWritingPatterns(origCombined).metrics;
      const postMetrics = analyzeWritingPatterns(refCombined).metrics;
      const validations = Array.from(refinedMap.values()).map((v) => ({
        sectionId: v.section.id,
        heading: v.section.heading,
        ...v.validation,
      }));

      await db
        .update(refinementJobs)
        .set({
          status: 'completed',
          progress: 100,
          refinedSectionsJson: JSON.stringify(finalSections),
          metricsJson: JSON.stringify({
            preMetrics,
            postMetrics,
            validations,
            engineUsed: engineMode === 'local' ? 'local-structural' : 'gemini-4-hydrogen',
          }),
          errorMessage: '',
          completedAt: new Date(),
        })
        .where(eq(refinementJobs.id, jobId));

      await logActivity(
        userId,
        'Paper Refinement',
        `Refined ${targetSections.length} section(s) [${mode}]`,
        docTitle,
        'Completed'
      );
    } catch (bgErr: any) {
      const msg = bgErr?.message || 'Refinement pipeline failed.';
      await db
        .update(refinementJobs)
        .set({
          status: 'failed',
          errorMessage: msg,
          metricsJson: JSON.stringify({ error: msg }),
        })
        .where(eq(refinementJobs.id, jobId));
    }
  })();
}

export function createApiRouter() {
  const router = express.Router();
  router.use(rateLimit);

  // ---------------- HEALTH & OPENAPI ----------------
  router.get('/health', (_req, res) => {
    const geminiConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
    res.json({
      status: 'ok',
      version: '1.1.0',
      canonicalBackend: 'python-fastapi',
      activeRuntime: /^https?:\/\//i.test(process.env.FASTAPI_URL || '') ? 'fastapi-proxy' : 'node-cloudsql-adapter',
      database: 'cloud-sql-postgresql',
      firebaseEnabled: true,
      demoEnabled: isDemoEnabled(),
      geminiConfigured,
      engines: [
        'document-parser',
        'similarity-ir',
        'stylometrics-24-cv',
        'citation-registries-6state',
        'static-ast-4state',
        'quality-13dim-critique',
        'audit-6pillar',
        'export-ieee-2col-docx-pdf',
      ],
    });
  });

  router.get('/ready', async (_req, res) => {
    let dbOk = false;
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return res.status(dbOk ? 200 : 503).json({
      ready: dbOk,
      checks: {
        database: dbOk ? 'ok' : 'unavailable',
        demoEnabled: isDemoEnabled(),
      },
    });
  });

  router.get('/docs/openapi.json', (_req, res) => {
    res.json({
      openapi: '3.0.3',
      info: {
        title: 'ResearchForge AI V1.1 API',
        version: '1.1.0',
        description:
          'Canonical ResearchForge AI V1.1 REST API specification aligned across FastAPI and the Cloud SQL runtime adapter.',
      },
      paths: {
        '/api/auth/firebase': { post: { summary: 'Exchange Firebase ID Token for researcher profile' } },
        '/api/auth/login': { post: { summary: 'Authenticate local researcher account' } },
        '/api/auth/register': { post: { summary: 'Register new researcher account' } },
        '/api/dashboard/summary': { get: { summary: 'PostgreSQL-driven workspace analytics' } },
        '/api/projects/analyze-zip': { post: { summary: 'Static AST/ZIP analysis with safety quotas' } },
        '/api/projects/analyze-github': { post: { summary: 'Static public HTTPS GitHub analysis' } },
        '/api/project-analysis/crosscheck': { post: { summary: '4-state paper-vs-code claim audit' } },
        '/api/documents/upload': { post: { summary: 'Magic-byte verified manuscript parsing & chunk indexing' } },
        '/api/research-generator/generate': { post: { summary: 'IEEE/APA generation grounded in AST & OpenAlex' } },
        '/api/similarity/analyze': { post: { summary: 'Multi-layer similarity with paraphrase & chunk support' } },
        '/api/writing-analysis/analyze': { post: { summary: 'Stylometrics + leave-one-topic-out evaluation' } },
        '/api/citations/verify': { post: { summary: '6-state citation audit across 4 registries' } },
        '/api/citations/verify-bibtex': { post: { summary: 'Parse & cross-reference BibTeX entries against Crossref & scholarly registries' } },
        '/api/citations/export-bibtex': { post: { summary: 'Verified-only default BibTeX exporter with syntax validation' } },
        '/api/research-quality/evaluate': { post: { summary: '13-dimension detailed rubric + optional LLM critique' } },
        '/api/integrity-audit/run': { post: { summary: '6-pillar unified final research integrity audit' } },
        '/api/paper-refinement/start': { post: { summary: 'Durable async refinement pipeline' } },
        '/api/reports': { get: { summary: 'Persisted audits & module reports' } },
      },
    });
  });

  // ---------------- AUTHENTICATION ----------------
  router.post('/auth/register', authRateLimit, async (req, res) => {
    try {
      const { email, password, name, institution = '' } = req.body ?? {};
      if (!email || !password || !name || String(password).length < 8) {
        return res.status(400).json({ error: 'Name, valid email, and password (min 8 chars) are required.' });
      }
      const normalizedEmail = String(email).trim().toLowerCase();
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
      if (existing.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      const id = newId('usr');
      const passwordHash = bcrypt.hashSync(String(password), 10);
      // Role is strictly server-assigned to prevent privilege escalation.
      const inserted = await db
        .insert(users)
        .values({
          id,
          uid: `local_${id}`,
          email: normalizedEmail,
          name: String(name).trim(),
          institution: String(institution).trim(),
          role: 'Researcher',
          passwordHash,
          authProvider: 'local',
          consentAnalytics: false,
          consentRetention: true,
        })
        .returning();

      const u = inserted[0];
      const token = signSessionToken({ sub: u.id, email: u.email, provider: 'local' });
      return res.status(201).json({
        token,
        user: {
          id: u.id,
          email: u.email,
          name: u.name,
          institution: u.institution,
          role: u.role,
          authProvider: u.authProvider,
          consentAnalytics: u.consentAnalytics,
          consentRetention: u.consentRetention,
        },
      });
    } catch (error) {
      console.error('Register error:', error);
      return res.status(500).json({ error: 'Failed to create researcher account.' });
    }
  });

  router.post('/auth/login', authRateLimit, async (req, res) => {
    try {
      const { email, password } = req.body ?? {};
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }
      const normalizedEmail = String(email).trim().toLowerCase();
      const rows = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
      const row = rows[0];
      if (
        !row ||
        row.authProvider === 'firebase' ||
        row.authProvider === 'demo' ||
        !row.passwordHash ||
        !bcrypt.compareSync(String(password), row.passwordHash)
      ) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      const token = signSessionToken({ sub: row.id, email: row.email, provider: 'local' });
      return res.json({
        token,
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          institution: row.institution,
          role: row.role,
          authProvider: row.authProvider,
          consentAnalytics: row.consentAnalytics,
          consentRetention: row.consentRetention,
        },
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Authentication service unavailable.' });
    }
  });

  router.post('/auth/firebase', authRateLimit, async (req, res) => {
    try {
      const { idToken } = req.body ?? {};
      const authHeader = req.headers.authorization;
      const token = String(idToken || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '')).trim();
      if (!token) {
        return res.status(400).json({ error: 'Firebase ID token is required.' });
      }
      const checkRevoked = process.env.FIREBASE_CHECK_REVOKED === 'true';
      const decodedRaw = await adminAuth.verifyIdToken(token, checkRevoked);
      const claims = validateFirebaseDecodedClaims(decodedRaw);
      if (!claims) {
        return res.status(401).json({ error: 'Invalid Firebase token claims.' });
      }
      const u = await getOrCreateFirebaseUser(claims.uid, claims.email || '', claims.name);
      return res.json({
        token,
        user: {
          id: u.id,
          email: u.email,
          name: u.name,
          institution: u.institution,
          role: u.role,
          authProvider: u.authProvider,
          consentAnalytics: u.consentAnalytics,
          consentRetention: u.consentRetention,
        },
      });
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (msg.includes('isolated demo workspace')) {
        return res.status(403).json({ error: msg });
      }
      console.error('Firebase token verification error:', error);
      return res.status(401).json({ error: 'Invalid or expired Firebase authentication token.' });
    }
  });

  router.post('/auth/demo', authRateLimit, async (_req, res) => {
    if (!isDemoEnabled()) {
      return res.status(403).json({ error: 'Demo workspace login is disabled in production.' });
    }
    try {
      const demoUser = await ensureDemoWorkspaceSeeded();
      const token = signSessionToken({ sub: demoUser.id, email: demoUser.email, provider: 'demo' });
      return res.json({
        token,
        user: {
          id: demoUser.id,
          email: demoUser.email,
          name: demoUser.name,
          institution: demoUser.institution,
          role: demoUser.role,
          authProvider: demoUser.authProvider,
          consentAnalytics: demoUser.consentAnalytics,
          consentRetention: demoUser.consentRetention,
        },
      });
    } catch (error) {
      console.error('Demo login error:', error);
      return res.status(500).json({ error: 'Failed to prepare demo workspace.' });
    }
  });

  router.post('/auth/logout', requireAuth, async (req: AuthRequest, res) => {
    await logActivity(req.user!.id, 'Authentication', 'Signed out of workspace', req.user!.email, 'Completed');
    return res.json({ loggedOut: true });
  });

  router.get('/auth/me', requireAuth, (req: AuthRequest, res) => {
    const u = req.user!;
    return res.json({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        institution: u.institution,
        role: u.role,
        authProvider: u.authProvider,
        consentAnalytics: u.consentAnalytics,
        consentRetention: u.consentRetention,
      },
    });
  });

  const handleUpdateSettings = async (req: AuthRequest, res: Response) => {
    try {
      const { name, institution, consentAnalytics, consentRetention } = req.body ?? {};
      const updates: Record<string, any> = {};
      if (typeof name === 'string' && name.trim()) updates.name = name.trim();
      if (typeof institution === 'string') updates.institution = institution.trim();
      if (typeof consentAnalytics === 'boolean') updates.consentAnalytics = consentAnalytics;
      if (typeof consentRetention === 'boolean') updates.consentRetention = consentRetention;

      if (Object.keys(updates).length > 0) {
        await db.update(users).set(updates).where(eq(users.id, req.user!.id));
      }
      const [fresh] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
      const u = fresh || req.user!;
      return res.json({
        updated: true,
        user: {
          id: u.id,
          email: u.email,
          name: u.name,
          institution: u.institution,
          role: u.role,
          authProvider: u.authProvider,
          consentAnalytics: u.consentAnalytics,
          consentRetention: u.consentRetention,
        },
      });
    } catch (error) {
      console.error('Settings update error:', error);
      return res.status(500).json({ error: 'Failed to update researcher settings.' });
    }
  };
  router.patch('/auth/settings', requireAuth, handleUpdateSettings);
  router.put('/auth/settings', requireAuth, handleUpdateSettings);

  router.delete('/auth/data', requireAuth, async (req: AuthRequest, res) => {
    try {
      await clearUserWorkspaceData(req.user!.id);
      return res.json({ cleared: true });
    } catch (error) {
      console.error('Workspace purge error:', error);
      return res.status(500).json({ error: 'Failed to clear workspace data.' });
    }
  });

  // ---------------- DASHBOARD ----------------
  router.get('/dashboard/summary', requireAuth, async (req: AuthRequest, res) => {
    try {
      const summary = await getUserDashboardData(req.user!.id);
      const geminiConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
      return res.json({ ...summary, geminiConfigured });
    } catch (error) {
      console.error('Dashboard error:', error);
      return res.status(500).json({ error: 'Failed to retrieve workspace dashboard.' });
    }
  });

  // ---------------- PROJECTS & MODULE 6 ANALYZER ----------------
  router.get('/projects', requireAuth, async (req: AuthRequest, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.userId, req.user!.id))
        .orderBy(desc(projects.updatedAt))
        .limit(limit)
        .offset(offset);
      return res.json({
        projects: rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          domain: r.domain,
          source_type: r.sourceType,
          source_url: r.sourceUrl,
          status: r.status,
          analysis: JSON.parse(r.analysisJson || '{}'),
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
        })),
        pagination: { limit, offset },
      });
    } catch (error) {
      console.error('Projects list error:', error);
      return res.status(500).json({ error: 'Failed to retrieve projects.' });
    }
  });

  router.post('/projects/analyze-zip', requireAuth, upload.single('archive'), async (req: AuthRequest, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Please upload a .zip project archive.' });
      if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Only .zip archives are accepted for repository uploads.' });
      }
      const analysis = await analyzeZipArchive(req.file.buffer, req.file.originalname);
      const id = newId('proj');
      const title = (req.body?.title as string)?.trim() || analysis.projectName;
      const domain = (req.body?.domain as string)?.trim() || 'Software & AI Systems';
      const description =
        (req.body?.description as string)?.trim() ||
        `Static extraction across ${analysis.fileCount} files (${analysis.languages.join(', ') || 'Source Archive'}).`;

      const [inserted] = await db
        .insert(projects)
        .values({
          id,
          userId: req.user!.id,
          title,
          description,
          domain,
          sourceType: 'zip_archive',
          sourceUrl: `upload://${req.file.originalname}`,
          status: 'analyzed',
          analysisJson: JSON.stringify(analysis),
        })
        .returning();

      await logActivity(req.user!.id, 'Project Analyzer', 'Analyzed ZIP repository statically', title, 'Verified');
      return res.status(201).json({
        project: {
          id: inserted.id,
          title: inserted.title,
          description: inserted.description,
          domain: inserted.domain,
          source_type: inserted.sourceType,
          source_url: inserted.sourceUrl,
          analysis,
          created_at: inserted.createdAt.toISOString(),
        },
      });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Failed to parse project ZIP archive.' });
    }
  });

  router.post('/projects/analyze-github', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { repoUrl, title, domain } = req.body ?? {};
      if (!repoUrl) return res.status(400).json({ error: 'GitHub repository URL is required.' });
      const analysis = await analyzeGithubRepository(String(repoUrl));
      const id = newId('proj');
      const finalTitle = title?.trim() || analysis.projectName;
      const finalDomain = domain?.trim() || 'Computer Science';
      const desc = `Static GitHub inspection (${analysis.fileCount} files, ${analysis.totalLines} lines).`;

      const [inserted] = await db
        .insert(projects)
        .values({
          id,
          userId: req.user!.id,
          title: finalTitle,
          description: desc,
          domain: finalDomain,
          sourceType: 'github',
          sourceUrl: String(repoUrl).trim(),
          status: 'analyzed',
          analysisJson: JSON.stringify(analysis),
        })
        .returning();

      await logActivity(req.user!.id, 'Project Analyzer', 'Analyzed public GitHub repository', finalTitle, 'Verified');
      return res.status(201).json({
        project: {
          id: inserted.id,
          title: inserted.title,
          description: inserted.description,
          domain: inserted.domain,
          source_type: inserted.sourceType,
          source_url: inserted.sourceUrl,
          analysis,
          created_at: inserted.createdAt.toISOString(),
        },
      });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Unable to inspect GitHub repository.' });
    }
  });

  router.post('/project-analysis/crosscheck', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { projectId, documentId, customText } = req.body ?? {};
      const [proj] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, String(projectId)), eq(projects.userId, req.user!.id)))
        .limit(1);
      if (!proj) return res.status(404).json({ error: 'Project not found.' });

      let paperText = String(customText || '');
      let docTitle = 'Custom Manuscript Excerpt';
      if (documentId) {
        const [doc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, String(documentId)), eq(documents.userId, req.user!.id)))
          .limit(1);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        paperText = doc.rawText;
        docTitle = doc.title;
      }
      if (!paperText.trim()) {
        return res.status(400).json({ error: 'Provide a document or manuscript text to cross-check.' });
      }

      const analysis: ExtractedProjectAnalysis = JSON.parse(proj.analysisJson);
      const findings = crossCheckPaperAgainstCode(paperText, analysis);
      const hasUnsupported = findings.some((f) => f.status === 'Unsupported');
      await logActivity(
        req.user!.id,
        'Project Analyzer',
        `Cross-checked "${docTitle}" vs "${proj.title}"`,
        docTitle,
        hasUnsupported ? 'Needs review' : 'Verified'
      );
      return res.json({ projectTitle: proj.title, documentTitle: docTitle, findings });
    } catch (error) {
      console.error('Crosscheck error:', error);
      return res.status(500).json({ error: 'Cross-check execution failed.' });
    }
  });

  router.delete('/projects/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      await db.delete(projects).where(and(eq(projects.id, req.params.id), eq(projects.userId, req.user!.id)));
      return res.json({ deleted: true });
    } catch (error) {
      console.error('Project delete error:', error);
      return res.status(500).json({ error: 'Failed to delete project.' });
    }
  });

  // ---------------- DOCUMENTS & STUDIO ----------------
  router.get('/documents', requireAuth, async (req: AuthRequest, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const rows = await db
        .select({
          id: documents.id,
          project_id: documents.projectId,
          title: documents.title,
          format: documents.format,
          citation_style: documents.citationStyle,
          word_count: documents.wordCount,
          status: documents.status,
          created_at: documents.createdAt,
          updated_at: documents.updatedAt,
        })
        .from(documents)
        .where(eq(documents.userId, req.user!.id))
        .orderBy(desc(documents.updatedAt))
        .limit(limit)
        .offset(offset);
      return res.json({
        documents: rows.map((d) => ({
          ...d,
          created_at: d.created_at.toISOString(),
          updated_at: d.updated_at.toISOString(),
        })),
        pagination: { limit, offset },
      });
    } catch (error) {
      console.error('Documents list error:', error);
      return res.status(500).json({ error: 'Failed to retrieve documents.' });
    }
  });

  router.get('/documents/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, req.params.id), eq(documents.userId, req.user!.id)))
        .limit(1);
      if (!doc) return res.status(404).json({ error: 'Document not found.' });

      const vers = await db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id))
        .orderBy(desc(documentVersions.versionNumber));

      return res.json({
        document: {
          id: doc.id,
          project_id: doc.projectId,
          title: doc.title,
          format: doc.format,
          citation_style: doc.citationStyle,
          raw_text: doc.rawText,
          word_count: doc.wordCount,
          status: doc.status,
          sections: JSON.parse(doc.sectionsJson || '[]'),
          references: JSON.parse(doc.referencesJson || '[]'),
          metadata: JSON.parse(doc.metadataJson || '{}'),
          created_at: doc.createdAt.toISOString(),
          updated_at: doc.updatedAt.toISOString(),
        },
        versions: vers.map((v) => ({
          id: v.id,
          version_number: v.versionNumber,
          label: v.label,
          raw_text: v.rawText,
          sections: JSON.parse(v.sectionsJson || '[]'),
          created_at: v.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      console.error('Document detail error:', error);
      return res.status(500).json({ error: 'Failed to fetch document.' });
    }
  });

  router.post('/documents/upload', requireAuth, upload.single('file'), async (req: AuthRequest, res) => {
    try {
      let parsed;
      let title = (req.body?.title as string)?.trim();

      if (req.file) {
        parsed = await parseDocumentBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
        title = title || req.file.originalname.replace(/\.[^.]+$/, '');
      } else if (req.body?.rawText) {
        parsed = parseRawText(String(req.body.rawText), String(req.body.format || 'txt'));
        title = title || 'Untitled Manuscript';
      } else {
        return res
          .status(400)
          .json({ error: 'Upload a supported file (.pdf, .docx, .doc, .txt, .md, .rtf, .tex, .bib) or supply text.' });
      }

      const cleanProjectId = req.body?.projectId ? String(req.body.projectId).trim() : null;
      if (cleanProjectId) {
        const [ownedProj] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, cleanProjectId), eq(projects.userId, req.user!.id)))
          .limit(1);
        if (!ownedProj) {
          return res.status(404).json({ error: 'Referenced project not found.' });
        }
      }

      const id = newId('doc');
      const parseMeta = {
        citationsFound: parsed.citationsFound,
        equationsFound: parsed.equationsFound,
        tablesFound: parsed.tablesFound,
        figuresFound: parsed.figuresFound,
        ocrRequired: parsed.ocrRequired,
        warnings: parsed.warnings,
      };

      await db.insert(documents).values({
        id,
        userId: req.user!.id,
        projectId: cleanProjectId,
        title,
        format: parsed.format,
        citationStyle: req.body?.citationStyle || 'IEEE',
        rawText: parsed.rawText,
        sectionsJson: JSON.stringify(parsed.sections),
        referencesJson: JSON.stringify(parsed.references),
        metadataJson: JSON.stringify(parseMeta),
        wordCount: parsed.wordCount,
        status: 'draft',
      });

      await db.insert(documentVersions).values({
        id: newId('ver'),
        documentId: id,
        versionNumber: 1,
        label: 'Initial Upload',
        sectionsJson: JSON.stringify(parsed.sections),
        rawText: parsed.rawText,
      });

      await indexDocumentChunks(req.user!.id, id, title, parsed.rawText);
      await logActivity(
        req.user!.id,
        'Documents',
        `Parsed ${parsed.format.toUpperCase()} manuscript`,
        title,
        parsed.ocrRequired ? 'Needs review' : 'Completed'
      );

      return res.status(201).json({
        document: {
          id,
          title,
          format: parsed.format,
          raw_text: parsed.rawText,
          sections: parsed.sections,
          references: parsed.references,
          word_count: parsed.wordCount,
          status: 'draft',
        },
        parseMeta,
      });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Document parsing failed.' });
    }
  });

  router.patch('/documents/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, req.params.id), eq(documents.userId, req.user!.id)))
        .limit(1);
      if (!doc) return res.status(404).json({ error: 'Document not found.' });

      const { title, citationStyle, sections, references, versionLabel } = req.body ?? {};
      const secArr: ParsedSection[] = Array.isArray(sections) ? sections : [];
      const refArr: string[] = Array.isArray(references) ? references : [];
      const rawText =
        secArr.map((s) => `${s.heading}\n${s.content}`).join('\n\n') +
        (refArr.length > 0 ? '\n\nReferences\n' + refArr.join('\n') : '');
      const wordCount = rawText.split(/\s+/).filter(Boolean).length;

      await db
        .update(documents)
        .set({
          title: title || doc.title,
          citationStyle: citationStyle || doc.citationStyle,
          sectionsJson: JSON.stringify(secArr),
          referencesJson: JSON.stringify(refArr),
          rawText,
          wordCount,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.id, doc.id), eq(documents.userId, req.user!.id)));

      const [maxRow] = await db
        .select({ m: sql<number>`COALESCE(MAX(version_number), 0)::int` })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id));
      const nextVer = (maxRow?.m ?? 0) + 1;

      await db.insert(documentVersions).values({
        id: newId('ver'),
        documentId: doc.id,
        versionNumber: nextVer,
        label: versionLabel || `Revision v${nextVer}`,
        sectionsJson: JSON.stringify(secArr),
        rawText,
      });

      await indexDocumentChunks(req.user!.id, doc.id, title || doc.title, rawText);
      await logActivity(req.user!.id, 'Writing Studio', `Saved revision v${nextVer}`, title || doc.title, 'Completed');
      return res.json({ saved: true, versionNumber: nextVer, wordCount });
    } catch (error) {
      console.error('Document patch error:', error);
      return res.status(500).json({ error: 'Failed to save manuscript revision.' });
    }
  });

  router.delete('/documents/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      await db.delete(documents).where(and(eq(documents.id, req.params.id), eq(documents.userId, req.user!.id)));
      return res.json({ deleted: true });
    } catch (error) {
      console.error('Document delete error:', error);
      return res.status(500).json({ error: 'Failed to delete document.' });
    }
  });

  router.get('/documents/:id/export', requireAuth, async (req: AuthRequest, res) => {
    try {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, req.params.id), eq(documents.userId, req.user!.id)))
        .limit(1);
      if (!doc) return res.status(404).json({ error: 'Document not found.' });

      const format = String(req.query.format || 'docx').toLowerCase();
      const style = String(req.query.style || doc.citationStyle || 'IEEE').toUpperCase();
      const includeUnverified = String(req.query.includeUnverified || 'false').toLowerCase() === 'true';
      const sections: ParsedSection[] = JSON.parse(doc.sectionsJson || '[]');
      const references: string[] = JSON.parse(doc.referencesJson || '[]');
      const safeSlug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) || 'manuscript';

      if (format === 'bib') {
        const persisted = await db
          .select()
          .from(citationsTable)
          .where(and(eq(citationsTable.documentId, doc.id), eq(citationsTable.userId, req.user!.id)))
          .orderBy(desc(citationsTable.createdAt));

        let bibItems: Array<Record<string, any> | string> = references;
        if (persisted.length > 0) {
          const seenRaw = new Set<string>();
          bibItems = [];
          for (const row of persisted) {
            if (seenRaw.has(row.rawReference)) continue;
            seenRaw.add(row.rawReference);
            try {
              const parsedDetail = JSON.parse(row.detailsJson || '{}');
              if (parsedDetail && typeof parsedDetail === 'object' && Object.keys(parsedDetail).length > 0) {
                bibItems.push(parsedDetail);
                continue;
              }
            } catch {
              // fallback to columns
            }
            bibItems.push({
              id: row.id,
              rawReference: row.rawReference,
              matchedTitle: row.title,
              authors: row.authors.split(',').map((a) => a.trim()).filter(Boolean),
              year: row.year,
              venue: row.venue,
              doi: row.doi,
              url: row.url,
              status: row.verificationStatus.toLowerCase().includes('verified') ? 'Verified' : 'Unverified',
            });
          }
        }

        const exported = exportBibtexCollection(bibItems, includeUnverified);
        res.setHeader('Content-Type', 'application/x-bibtex');
        res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}.bib"`);
        return res.send(exported.bibtex);
      }

      if (format === 'docx') {
        const buf = await generateDocxBuffer({ title: doc.title, sections, references, style });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}.docx"`);
        return res.send(buf);
      }
      if (format === 'pdf') {
        const buf = generatePdfBuffer({
          title: doc.title,
          sections,
          references,
          style,
          subtitle: `Prepared in ${style} Academic Format`,
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}.pdf"`);
        return res.send(buf);
      }
      if (format === 'tex') {
        const docClass = style === 'APA' ? '\\documentclass[man,apa7]{apa7}' : '\\documentclass[conference]{IEEEtran}';
        const tex = `${docClass}\n\\title{${doc.title}}\n\\begin{document}\n\\maketitle\n${sections
          .map((s) => `\\section{${s.heading}}\n${s.content}`)
          .join('\n\n')}\n\\begin{thebibliography}{99}\n${references.map((r, i) => `\\bibitem{ref${i + 1}} ${r}`).join('\n')}\n\\end{thebibliography}\n\\end{document}`;
        res.setHeader('Content-Type', 'application/x-tex');
        res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}.tex"`);
        return res.send(tex);
      }
      const md = `# ${doc.title}\n\n${sections.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n')}\n\n## References\n\n${references.join('\n')}`;
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}.md"`);
      return res.send(md);
    } catch (error) {
      console.error('Export error:', error);
      return res.status(500).json({ error: 'Manuscript export failed.' });
    }
  });

  // ---------------- MODULE 1: RESEARCH PAPER GENERATOR ----------------
  router.post('/research-generator/generate', requireAuth, async (req: AuthRequest, res) => {
    try {
      const {
        projectId,
        title,
        synopsis,
        datasetNotes,
        experimentalResults,
        literatureNotes,
        paperFormat = 'IEEE',
        engineMode = 'gemini',
      } = req.body ?? {};
      if (!title || String(title).trim().length < 3) {
        return res.status(400).json({ error: 'Paper title is required.' });
      }
      let projectAnalysis: ExtractedProjectAnalysis | null = null;
      if (projectId) {
        const [proj] = await db
          .select()
          .from(projects)
          .where(and(eq(projects.id, String(projectId)), eq(projects.userId, req.user!.id)))
          .limit(1);
        if (!proj) return res.status(404).json({ error: 'Referenced project not found.' });
        projectAnalysis = JSON.parse(proj.analysisJson);
      }

      const formatStd = String(paperFormat).toUpperCase() === 'APA' ? 'APA' : 'IEEE';
      const generated = await generateResearchPaper({
        projectAnalysis,
        title: String(title).trim(),
        synopsis: String(synopsis || ''),
        datasetNotes: String(datasetNotes || ''),
        experimentalResults: String(experimentalResults || ''),
        literatureNotes: String(literatureNotes || ''),
        paperFormat: formatStd,
        engineMode: engineMode === 'local' ? 'local' : 'gemini',
      });

      const docId = newId('doc');
      const rawText =
        generated.sections.map((s) => `${s.heading}\n${s.content}`).join('\n\n') +
        '\n\nReferences\n' +
        generated.references.join('\n');
      const wordCount = rawText.split(/\s+/).filter(Boolean).length;

      await db.insert(documents).values({
        id: docId,
        userId: req.user!.id,
        projectId: projectId || null,
        title: generated.title,
        format: formatStd.toLowerCase(),
        citationStyle: formatStd,
        rawText,
        sectionsJson: JSON.stringify(generated.sections),
        referencesJson: JSON.stringify(generated.references),
        metadataJson: JSON.stringify({ engineUsed: generated.engineUsed, groundingSummary: generated.groundingSummary }),
        wordCount,
        status: 'draft',
      });

      await db.insert(documentVersions).values({
        id: newId('ver'),
        documentId: docId,
        versionNumber: 1,
        label: `Generated ${formatStd} Draft`,
        sectionsJson: JSON.stringify(generated.sections),
        rawText,
      });

      await indexDocumentChunks(req.user!.id, docId, generated.title, rawText);
      await logActivity(
        req.user!.id,
        'Paper Generator',
        `Generated ${formatStd} draft (${generated.engineUsed})`,
        generated.title,
        'Completed'
      );
      return res.status(201).json({ documentId: docId, generated });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Research paper generation failed.' });
    }
  });

  // ---------------- MODULE 2: SIMILARITY ENGINE ----------------
  router.post('/similarity/analyze', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { documentId, text, title = 'Ad-hoc Similarity Scan', queryArxiv = true } = req.body ?? {};
      let targetText = String(text || '');
      let targetTitle = String(title);

      if (documentId) {
        const [doc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, String(documentId)), eq(documents.userId, req.user!.id)))
          .limit(1);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        targetText = doc.rawText;
        targetTitle = doc.title;
      }
      if (targetText.trim().length < 25) {
        return res.status(400).json({ error: 'Supply at least 25 characters of manuscript text for similarity scanning.' });
      }

      const pgChunks = await queryPgvectorSimilarChunks(req.user!.id, targetText, documentId ? String(documentId) : undefined, 8);
      const pgDocIds = new Set(pgChunks.map((c: { id: string }) => c.id));

      const otherDocs = await db
        .select({ id: documents.id, title: documents.title, rawText: documents.rawText })
        .from(documents)
        .where(and(eq(documents.userId, req.user!.id), ne(documents.id, String(documentId || ''))))
        .limit(10);

      const workspaceCorpus: CorpusDocument[] = [
        ...pgChunks,
        ...otherDocs
          .filter((d) => !pgDocIds.has(d.id))
          .map((d) => ({
            id: d.id,
            title: d.title,
            source: 'Workspace Document',
            text: d.rawText,
          })),
      ];

      const arxivDocs = queryArxiv ? await fetchArxivRelatedAbstracts(targetText.slice(0, 300), 4) : [];
      const fullCorpus = [...BUILTIN_REFERENCE_CORPUS, ...workspaceCorpus, ...arxivDocs];
      const result = analyzeTextSimilarity(targetText, fullCorpus, arxivDocs.length, 0);

      const reportId = newId('sim');
      await db.insert(similarityReports).values({
        id: reportId,
        userId: req.user!.id,
        documentId: documentId || null,
        title: targetTitle,
        overallSimilarity: result.overallSimilarityPercent,
        corpusCoverage: result.corpusCoverage.limitationNotice,
        resultsJson: JSON.stringify(result),
      });

      await logActivity(
        req.user!.id,
        'Similarity Engine',
        `Scanned (${result.overallSimilarityPercent}% composite overlap)`,
        targetTitle,
        result.uncitedFlagCount > 0 ? 'Needs review' : 'Verified'
      );
      return res.json({ reportId, title: targetTitle, result });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Similarity analysis failed.' });
    }
  });

  // ---------------- MODULE 3: AI-WRITING ANALYZER ----------------
  router.post('/writing-analysis/analyze', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { documentId, text, title = 'Linguistic Telemetry Scan' } = req.body ?? {};
      let targetText = String(text || '');
      let targetTitle = String(title);

      if (documentId) {
        const [doc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, String(documentId)), eq(documents.userId, req.user!.id)))
          .limit(1);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        targetText = doc.rawText;
        targetTitle = doc.title;
      }
      if (targetText.trim().length < 40) {
        return res.status(400).json({ error: 'Supply at least 40 characters for stylometric analysis.' });
      }

      const analysis = analyzeWritingPatterns(targetText);
      const id = newId('wrt');
      await db.insert(writingAnalyses).values({
        id,
        userId: req.user!.id,
        documentId: documentId || null,
        title: targetTitle,
        metricsJson: JSON.stringify(analysis),
        observationsJson: JSON.stringify(analysis.observations),
      });

      await logActivity(
        req.user!.id,
        'Writing Analyzer',
        'Computed stylometric & cross-validated profile',
        targetTitle,
        'Completed'
      );
      return res.json({ analysisId: id, title: targetTitle, analysis });
    } catch (error) {
      console.error('Writing analysis error:', error);
      return res.status(500).json({ error: 'Stylometric analysis failed.' });
    }
  });

  // ---------------- MODULE 4: CITATION INTELLIGENCE ----------------
  router.post('/citations/verify', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { documentId, referencesText, claimText, sourceTitle } = req.body ?? {};
      let refs: string[] = [];
      let fullText = '';
      let targetTitle = 'Manual Bibliography Audit';

      if (documentId) {
        const [doc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, String(documentId)), eq(documents.userId, req.user!.id)))
          .limit(1);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        targetTitle = doc.title;
        fullText = doc.rawText;
        refs = JSON.parse(doc.referencesJson || '[]');
      }
      if (referencesText && String(referencesText).trim()) {
        refs = String(referencesText)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 5);
      }

      if (refs.length === 0) {
        return res.status(400).json({
          error: 'No references found to verify. Paste bibliography lines or select a document with references.',
        });
      }

      const audit = await verifyBibliography(refs, fullText);
      const claimCheck =
        claimText && sourceTitle ? checkClaimToSourceRelevance(String(claimText), String(sourceTitle)) : null;

      const id = newId('cit');
      await db.insert(citationChecks).values({
        id,
        userId: req.user!.id,
        documentId: documentId || null,
        title: targetTitle,
        citationsJson: JSON.stringify(audit.citations),
        summaryJson: JSON.stringify(audit.summary),
      });

      if (audit.citations.length > 0) {
        await db.insert(citationsTable).values(
          audit.citations.map((c) => ({
            id: newId('citrow'),
            userId: req.user!.id,
            documentId: documentId || null,
            rawReference: c.rawReference,
            doi: c.verifiedMetadata?.doi || c.extractedDoi || '',
            title: c.verifiedMetadata?.title || c.extractedTitle,
            authors: (c.verifiedMetadata?.authors || []).join(', ').slice(0, 500),
            year: String(c.verifiedMetadata?.year ?? c.extractedYear ?? ''),
            venue: (c.verifiedMetadata?.venue || '').slice(0, 250),
            url: (c.verifiedMetadata?.url || '').slice(0, 500),
            verificationStatus: c.bibliographicStatus,
            claimSupportStatus: c.claimSupportStatus,
            sourceProvider: c.matchedProvider,
            detailsJson: JSON.stringify(c),
          }))
        );
      }

      await logActivity(
        req.user!.id,
        'Citation Intelligence',
        `Verified ${audit.summary.verifiedCount}/${audit.summary.totalReferences} citations`,
        targetTitle,
        audit.summary.unverifiedCount > 0 ? 'Unverified' : audit.summary.needsReviewCount > 0 ? 'Needs review' : 'Verified'
      );

      return res.json({ checkId: id, title: targetTitle, audit, claimCheck });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Citation verification error.' });
    }
  });

  router.post('/citations/export-bibtex', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { documentId, citations, includeUnverified = false } = req.body ?? {};
      let items: Array<Record<string, any> | string> = [];

      if (Array.isArray(citations) && citations.length > 0) {
        items = citations;
      } else if (documentId) {
        const [doc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, String(documentId)), eq(documents.userId, req.user!.id)))
          .limit(1);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });

        const persisted = await db
          .select()
          .from(citationsTable)
          .where(and(eq(citationsTable.documentId, doc.id), eq(citationsTable.userId, req.user!.id)))
          .orderBy(desc(citationsTable.createdAt));

        if (persisted.length > 0) {
          const seenRaw = new Set<string>();
          for (const row of persisted) {
            if (seenRaw.has(row.rawReference)) continue;
            seenRaw.add(row.rawReference);
            try {
              const parsedDetail = JSON.parse(row.detailsJson || '{}');
              if (parsedDetail && typeof parsedDetail === 'object' && Object.keys(parsedDetail).length > 0) {
                items.push(parsedDetail);
                continue;
              }
            } catch {
              // fallback
            }
            items.push({
              id: row.id,
              rawReference: row.rawReference,
              matchedTitle: row.title,
              authors: row.authors.split(',').map((a) => a.trim()).filter(Boolean),
              year: row.year,
              venue: row.venue,
              doi: row.doi,
              url: row.url,
              status: row.verificationStatus.toLowerCase().includes('verified') ? 'Verified' : 'Unverified',
            });
          }
        } else {
          items = JSON.parse(doc.referencesJson || '[]');
        }
      } else {
        return res.status(400).json({ error: 'Provide citations or documentId to export BibTeX.' });
      }

      const result = exportBibtexCollection(items, Boolean(includeUnverified));
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'BibTeX export failed.' });
    }
  });

  router.post('/citations/verify-bibtex', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { bibtexText, includeUnverified = false } = req.body ?? {};
      if (!bibtexText || String(bibtexText).trim().length < 5) {
        return res.status(400).json({ error: 'Provide BibTeX entries (@article{...}, etc.) to verify.' });
      }
      const report = await verifyBibtexEntries(String(bibtexText), Boolean(includeUnverified));
      if (report.summary.totalEntries === 0) {
        return res
          .status(400)
          .json({ error: 'No valid BibTeX entries (@type{key, ...}) could be parsed from the provided input.' });
      }

      const id = newId('bibchk');
      await db.insert(citationChecks).values({
        id,
        userId: req.user!.id,
        documentId: null,
        title: 'BibTeX Cross-Reference Verification',
        citationsJson: JSON.stringify(report.entries),
        summaryJson: JSON.stringify(report.summary),
      });

      if (report.entries.length > 0) {
        await db.insert(citationsTable).values(
          report.entries.map((entry) => ({
            id: newId('citrow'),
            userId: req.user!.id,
            documentId: null,
            rawReference: entry.rawReference,
            doi: entry.doi || '',
            title: entry.matchedTitle || entry.declared.title || '',
            authors: entry.authors.join(', ').slice(0, 500),
            year: String(entry.year || ''),
            venue: String(entry.venue || '').slice(0, 250),
            url: String(entry.url || '').slice(0, 500),
            verificationStatus: entry.bibliographicStatus,
            claimSupportStatus: entry.verifiedMetadata ? 'Source retrieved' : 'Evidence insufficient',
            sourceProvider: entry.matchedProvider,
            detailsJson: JSON.stringify(entry),
          }))
        );
      }

      await logActivity(
        req.user!.id,
        'Citation Intelligence',
        `Verified ${report.summary.verifiedCount}/${report.summary.totalEntries} BibTeX entries`,
        'BibTeX Cross-Reference Audit',
        report.summary.unverifiedCount > 0 ? 'Unverified' : report.summary.needsReviewCount > 0 ? 'Needs review' : 'Verified'
      );

      return res.json({ checkId: id, ...report });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'BibTeX verification failed.' });
    }
  });

  // ---------------- MODULE 5: RESEARCH QUALITY EVALUATOR ----------------
  router.post('/research-quality/evaluate', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { documentId, text, title = 'Ad-hoc Manuscript Evaluation', includeLlmCritique = false } = req.body ?? {};
      let targetTitle = String(title);
      let rawText = String(text || '');
      let sections: ParsedSection[] = [];
      let references: string[] = [];

      if (documentId) {
        const [doc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, String(documentId)), eq(documents.userId, req.user!.id)))
          .limit(1);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        targetTitle = doc.title;
        rawText = doc.rawText;
        sections = JSON.parse(doc.sectionsJson || '[]');
        references = JSON.parse(doc.referencesJson || '[]');
      } else if (rawText.trim()) {
        const parsed = parseRawText(rawText);
        sections = parsed.sections;
        references = parsed.references;
      } else {
        return res.status(400).json({ error: 'Select a document or paste manuscript content to evaluate.' });
      }

      const llmCritique = includeLlmCritique ? await generateOptionalReviewerCritique(rawText) : undefined;
      const evaluation = evaluateResearchQuality(rawText, sections, references, llmCritique);

      const id = newId('qual');
      await db.insert(qualityEvaluations).values({
        id,
        userId: req.user!.id,
        documentId: documentId || null,
        title: targetTitle,
        dimensionsJson: JSON.stringify(evaluation),
        recommendationsJson: JSON.stringify(evaluation.recommendations),
      });

      await logActivity(
        req.user!.id,
        'Quality Evaluator',
        `Assessed ${evaluation.dimensions.length} methodology criteria`,
        targetTitle,
        'Completed'
      );
      return res.json({ evaluationId: id, title: targetTitle, evaluation });
    } catch (error) {
      console.error('Quality evaluation error:', error);
      return res.status(500).json({ error: 'Research quality evaluation failed.' });
    }
  });

  // ---------------- MODULE 8: FINAL RESEARCH INTEGRITY AUDIT ----------------
  router.post('/integrity-audit/run', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { documentId, projectId } = req.body ?? {};
      if (!documentId) return res.status(400).json({ error: 'Select a manuscript document to audit.' });

      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, String(documentId)), eq(documents.userId, req.user!.id)))
        .limit(1);
      if (!doc) return res.status(404).json({ error: 'Document not found.' });

      const [simRow] = await db
        .select()
        .from(similarityReports)
        .where(and(eq(similarityReports.documentId, doc.id), eq(similarityReports.userId, req.user!.id)))
        .orderBy(desc(similarityReports.createdAt))
        .limit(1);
      const [citRow] = await db
        .select()
        .from(citationChecks)
        .where(and(eq(citationChecks.documentId, doc.id), eq(citationChecks.userId, req.user!.id)))
        .orderBy(desc(citationChecks.createdAt))
        .limit(1);
      const [wrtRow] = await db
        .select()
        .from(writingAnalyses)
        .where(and(eq(writingAnalyses.documentId, doc.id), eq(writingAnalyses.userId, req.user!.id)))
        .orderBy(desc(writingAnalyses.createdAt))
        .limit(1);
      const [qualRow] = await db
        .select()
        .from(qualityEvaluations)
        .where(and(eq(qualityEvaluations.documentId, doc.id), eq(qualityEvaluations.userId, req.user!.id)))
        .orderBy(desc(qualityEvaluations.createdAt))
        .limit(1);

      const effectiveProjectId = projectId || doc.projectId;
      let codeCrossCheck = null;
      if (effectiveProjectId) {
        const [proj] = await db
          .select()
          .from(projects)
          .where(and(eq(projects.id, String(effectiveProjectId)), eq(projects.userId, req.user!.id)))
          .limit(1);
        if (proj) {
          codeCrossCheck = crossCheckPaperAgainstCode(doc.rawText, JSON.parse(proj.analysisJson));
        }
      }

      const audit = buildIntegrityAudit({
        similarity: simRow ? JSON.parse(simRow.resultsJson) : null,
        citations: citRow
          ? { citations: JSON.parse(citRow.citationsJson), summary: JSON.parse(citRow.summaryJson) }
          : null,
        writing: wrtRow ? JSON.parse(wrtRow.metricsJson) : null,
        quality: qualRow
          ? JSON.parse(qualRow.dimensionsJson)
          : evaluateResearchQuality(
              doc.rawText,
              JSON.parse(doc.sectionsJson || '[]'),
              JSON.parse(doc.referencesJson || '[]')
            ),
        codeCrossCheck,
      });

      const auditId = newId('aud');
      await db.insert(integrityAudits).values({
        id: auditId,
        userId: req.user!.id,
        projectId: effectiveProjectId || null,
        documentId: doc.id,
        title: doc.title,
        overallStatus: audit.overallStatus,
        findingsJson: JSON.stringify(audit.findings),
        summaryJson: JSON.stringify(audit.counts),
      });

      await db
        .update(documents)
        .set({ status: audit.overallStatus === 'Verified' ? 'verified' : 'needs_review' })
        .where(eq(documents.id, doc.id));

      await logActivity(
        req.user!.id,
        'Integrity Audit',
        `Final 6-pillar audit classified as ${audit.overallStatus}`,
        doc.title,
        audit.overallStatus
      );
      return res.json({ auditId, title: doc.title, audit });
    } catch (error) {
      console.error('Integrity audit error:', error);
      return res.status(500).json({ error: 'Integrity audit execution failed.' });
    }
  });

  router.get('/integrity-audit/:auditId/export', requireAuth, async (req: AuthRequest, res) => {
    try {
      const [aud] = await db
        .select()
        .from(integrityAudits)
        .where(and(eq(integrityAudits.id, req.params.auditId), eq(integrityAudits.userId, req.user!.id)))
        .limit(1);
      if (!aud) return res.status(404).json({ error: 'Integrity audit not found.' });

      const format = String(req.query.format || 'md').toLowerCase();
      const counts = JSON.parse(aud.summaryJson || '{}');
      const findings = JSON.parse(aud.findingsJson || '[]');
      const reconstructed = {
        overallStatus: aud.overallStatus as any,
        counts,
        findings,
        auditSummary: `${aud.overallStatus} (${counts.verified ?? 0} verified, ${counts.needsReview ?? 0} review, ${counts.unverified ?? 0} unverified).`,
      };

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="integrity-audit-${aud.id}.json"`);
        return res.send(JSON.stringify({ title: aud.title, ...reconstructed }, null, 2));
      }

      const md = formatIntegrityAuditMarkdown(aud.title, reconstructed);
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="integrity-audit-${aud.id}.md"`);
      return res.send(md);
    } catch (error) {
      console.error('Audit export error:', error);
      return res.status(500).json({ error: 'Failed to export integrity audit.' });
    }
  });

  // ---------------- MODULE 9: PAPER HUMANIZATION & REFINEMENT ENGINE ----------------
  router.post('/paper-refinement/start', requireAuth, async (req: AuthRequest, res) => {
    try {
      const {
        documentId,
        mode = 'Academic Clarity',
        scope = 'whole_paper',
        sectionIds,
        paragraphText = '',
        preserveTerms = '',
        engineMode = 'gemini',
      } = req.body ?? {};
      if (!documentId) return res.status(400).json({ error: 'documentId is required.' });

      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, String(documentId)), eq(documents.userId, req.user!.id)))
        .limit(1);
      if (!doc) return res.status(404).json({ error: 'Document not found.' });

      const allSections: ParsedSection[] = JSON.parse(doc.sectionsJson || '[]');
      let targetSections =
        (scope === 'selected_sections' || scope === 'selected_paragraphs') &&
        Array.isArray(sectionIds) &&
        sectionIds.length > 0
          ? allSections.filter((s) => sectionIds.includes(s.id))
          : allSections;

      let paragraphTarget: { sectionId: string; originalParagraph: string } | undefined;
      if (scope === 'selected_paragraphs' && String(paragraphText).trim()) {
        const cleanPara = String(paragraphText).trim();
        const owner = targetSections[0] ?? allSections[0];
        if (!owner) return res.status(400).json({ error: 'Document has no sections.' });
        targetSections = [owner];
        paragraphTarget = { sectionId: owner.id, originalParagraph: cleanPara };
      }

      if (targetSections.length === 0) {
        return res.status(400).json({ error: 'No sections available for refinement.' });
      }

      const jobId = newId('refjob');
      const engineChoice = engineMode === 'local' ? 'local' : 'gemini';
      await db.insert(refinementJobs).values({
        id: jobId,
        documentId: doc.id,
        userId: req.user!.id,
        mode: String(mode),
        scope: String(scope),
        status: 'queued',
        progress: 5,
        payloadJson: JSON.stringify({ sectionIds, preserveTerms, engineMode: engineChoice, paragraphTarget }),
        originalSectionsJson: JSON.stringify(allSections),
        refinedSectionsJson: '[]',
        metricsJson: JSON.stringify({ preserveTerms, engineMode: engineChoice, paragraphTarget }),
      });

      executeRefinementJobInBackground(
        jobId,
        req.user!.id,
        doc.id,
        doc.title,
        allSections,
        targetSections,
        mode as RefinementMode,
        String(scope),
        String(preserveTerms || ''),
        engineChoice,
        paragraphTarget
      );

      return res.status(202).json({ jobId, id: jobId, status: 'processing' });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Unable to start refinement pipeline.' });
    }
  });

  const handleGetJobStatus = async (req: AuthRequest, res: Response) => {
    try {
      const [job] = await db
        .select()
        .from(refinementJobs)
        .where(and(eq(refinementJobs.id, req.params.jobId), eq(refinementJobs.userId, req.user!.id)))
        .limit(1);
      if (!job) return res.status(404).json({ error: 'Refinement job not found.' });
      return res.json({
        id: job.id,
        documentId: job.documentId,
        mode: job.mode,
        scope: job.scope,
        status: job.status,
        progress: job.progress,
        errorMessage: job.errorMessage,
        retries: job.retries,
        cancelled: job.cancelled,
        originalSections: JSON.parse(job.originalSectionsJson || '[]'),
        refinedSections: JSON.parse(job.refinedSectionsJson || '[]'),
        metrics: JSON.parse(job.metricsJson || '{}'),
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
      });
    } catch (error) {
      console.error('Refinement job poll error:', error);
      return res.status(500).json({ error: 'Failed to inspect refinement job.' });
    }
  };

  const handleCancelJob = async (req: AuthRequest, res: Response) => {
    try {
      const [job] = await db
        .select()
        .from(refinementJobs)
        .where(and(eq(refinementJobs.id, req.params.jobId), eq(refinementJobs.userId, req.user!.id)))
        .limit(1);
      if (!job) return res.status(404).json({ error: 'Refinement job not found.' });

      await db
        .update(refinementJobs)
        .set({ cancelled: true, status: 'cancelled', errorMessage: 'Cancelled by researcher.' })
        .where(eq(refinementJobs.id, job.id));
      return res.json({ cancelled: true, id: job.id });
    } catch (error) {
      console.error('Refinement cancel error:', error);
      return res.status(500).json({ error: 'Failed to cancel refinement job.' });
    }
  };

  const handleRetryJob = async (req: AuthRequest, res: Response) => {
    try {
      const [job] = await db
        .select()
        .from(refinementJobs)
        .where(and(eq(refinementJobs.id, req.params.jobId), eq(refinementJobs.userId, req.user!.id)))
        .limit(1);
      if (!job) return res.status(404).json({ error: 'Refinement job not found.' });

      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, job.documentId), eq(documents.userId, req.user!.id)))
        .limit(1);
      if (!doc) return res.status(404).json({ error: 'Document not found.' });

      const allSections: ParsedSection[] = JSON.parse(job.originalSectionsJson || '[]');
      const storedPayload = JSON.parse(job.payloadJson || job.metricsJson || '{}');
      const storedMeta = JSON.parse(job.metricsJson || '{}');
      const targetIds: string[] = Array.isArray(storedPayload.sectionIds) ? storedPayload.sectionIds : [];
      const targetSections = targetIds.length > 0 ? allSections.filter((s) => targetIds.includes(s.id)) : allSections;
      const nextRetries = (job.retries ?? 0) + 1;

      await db
        .update(refinementJobs)
        .set({ status: 'queued', progress: 5, cancelled: false, errorMessage: '', retries: nextRetries })
        .where(eq(refinementJobs.id, job.id));

      executeRefinementJobInBackground(
        job.id,
        req.user!.id,
        doc.id,
        doc.title,
        allSections,
        targetSections.length > 0 ? targetSections : allSections,
        job.mode as RefinementMode,
        job.scope,
        String(storedPayload.preserveTerms ?? storedMeta.preserveTerms ?? ''),
        (storedPayload.engineMode ?? storedMeta.engineMode) === 'local' ? 'local' : 'gemini',
        storedPayload.paragraphTarget ?? storedMeta.paragraphTarget
      );

      return res.json({ retried: true, id: job.id, retries: nextRetries, status: 'processing' });
    } catch (error) {
      console.error('Refinement retry error:', error);
      return res.status(500).json({ error: 'Failed to retry refinement job.' });
    }
  };

  const handleApproveJob = async (req: AuthRequest, res: Response) => {
    try {
      const [job] = await db
        .select()
        .from(refinementJobs)
        .where(and(eq(refinementJobs.id, req.params.jobId), eq(refinementJobs.userId, req.user!.id)))
        .limit(1);
      if (!job || job.status !== 'completed') {
        return res.status(400).json({ error: 'Completed refinement job not found.' });
      }
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, job.documentId), eq(documents.userId, req.user!.id)))
        .limit(1);
      if (!doc) return res.status(404).json({ error: 'Document not found.' });

      const refinedSections: ParsedSection[] = req.body?.approvedSections || JSON.parse(job.refinedSectionsJson);
      const refs: string[] = JSON.parse(doc.referencesJson || '[]');
      const rawText =
        refinedSections.map((s) => `${s.heading}\n${s.content}`).join('\n\n') +
        (refs.length > 0 ? '\n\nReferences\n' + refs.join('\n') : '');
      const wordCount = rawText.split(/\s+/).filter(Boolean).length;

      await db
        .update(documents)
        .set({
          sectionsJson: JSON.stringify(refinedSections),
          rawText,
          wordCount,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, doc.id));

      const [maxRow] = await db
        .select({ m: sql<number>`COALESCE(MAX(version_number), 0)::int` })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id));
      const nextVer = (maxRow?.m ?? 0) + 1;

      await db.insert(documentVersions).values({
        id: newId('ver'),
        documentId: doc.id,
        versionNumber: nextVer,
        label: `Refined (${job.mode})`,
        sectionsJson: JSON.stringify(refinedSections),
        rawText,
      });

      await indexDocumentChunks(req.user!.id, doc.id, doc.title, rawText);
      await logActivity(req.user!.id, 'Paper Refinement', `Approved refined manuscript v${nextVer}`, doc.title, 'Completed');
      return res.json({ approved: true, versionNumber: nextVer });
    } catch (error) {
      console.error('Refinement approve error:', error);
      return res.status(500).json({ error: 'Failed to save approved revision.' });
    }
  };

  router.get('/paper-refinement/jobs/:jobId', requireAuth, handleGetJobStatus);
  router.get('/jobs/:jobId', requireAuth, handleGetJobStatus);
  router.post('/paper-refinement/jobs/:jobId/cancel', requireAuth, handleCancelJob);
  router.post('/paper-refinement/cancel/:jobId', requireAuth, handleCancelJob);
  router.post('/jobs/:jobId/cancel', requireAuth, handleCancelJob);
  router.post('/paper-refinement/jobs/:jobId/retry', requireAuth, handleRetryJob);
  router.post('/paper-refinement/retry/:jobId', requireAuth, handleRetryJob);
  router.post('/jobs/:jobId/retry', requireAuth, handleRetryJob);
  router.post('/paper-refinement/approve/:jobId', requireAuth, handleApproveJob);
  router.post('/paper-refinement/:jobId/approve', requireAuth, handleApproveJob);

  // ---------------- REPORTS & HISTORY ----------------
  router.get('/reports', requireAuth, async (req: AuthRequest, res) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const uid = req.user!.id;
      const [simRows, citRows, wrtRows, qualRows, audRows, jobRows] = await Promise.all([
        db.select().from(similarityReports).where(eq(similarityReports.userId, uid)).orderBy(desc(similarityReports.createdAt)).limit(limit).offset(offset),
        db.select().from(citationChecks).where(eq(citationChecks.userId, uid)).orderBy(desc(citationChecks.createdAt)).limit(limit).offset(offset),
        db.select().from(writingAnalyses).where(eq(writingAnalyses.userId, uid)).orderBy(desc(writingAnalyses.createdAt)).limit(limit).offset(offset),
        db.select().from(qualityEvaluations).where(eq(qualityEvaluations.userId, uid)).orderBy(desc(qualityEvaluations.createdAt)).limit(limit).offset(offset),
        db.select().from(integrityAudits).where(eq(integrityAudits.userId, uid)).orderBy(desc(integrityAudits.createdAt)).limit(limit).offset(offset),
        db.select().from(refinementJobs).where(eq(refinementJobs.userId, uid)).orderBy(desc(refinementJobs.createdAt)).limit(limit).offset(offset),
      ]);

      return res.json({
        similarity: simRows.map((r) => ({
          id: r.id,
          title: r.title,
          overall_similarity: r.overallSimilarity,
          corpus_coverage: r.corpusCoverage,
          results: JSON.parse(r.resultsJson || '{}'),
          created_at: r.createdAt.toISOString(),
        })),
        citations: citRows.map((r) => ({
          id: r.id,
          title: r.title,
          summary: JSON.parse(r.summaryJson || '{}'),
          citations: JSON.parse(r.citationsJson || '[]'),
          created_at: r.createdAt.toISOString(),
        })),
        writing: wrtRows.map((r) => ({
          id: r.id,
          title: r.title,
          analysis: JSON.parse(r.metricsJson || '{}'),
          created_at: r.createdAt.toISOString(),
        })),
        quality: qualRows.map((r) => ({
          id: r.id,
          title: r.title,
          evaluation: JSON.parse(r.dimensionsJson || '{}'),
          created_at: r.createdAt.toISOString(),
        })),
        audits: audRows.map((r) => ({
          id: r.id,
          title: r.title,
          overall_status: r.overallStatus,
          findings: JSON.parse(r.findingsJson || '[]'),
          summary: JSON.parse(r.summaryJson || '{}'),
          created_at: r.createdAt.toISOString(),
        })),
        refinementJobs: jobRows.map((j) => ({
          id: j.id,
          document_id: j.documentId,
          mode: j.mode,
          status: j.status,
          progress: j.progress,
          error_message: j.errorMessage,
          created_at: j.createdAt.toISOString(),
          completed_at: j.completedAt?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      console.error('Reports list error:', error);
      return res.status(500).json({ error: 'Failed to retrieve workspace reports.' });
    }
  });

  return router;
}
