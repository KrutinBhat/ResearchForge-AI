import bcrypt from 'bcryptjs';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from './index.ts';
import { newId } from './users.ts';
import {
  activityLogs,
  citationChecks,
  citations,
  corpusChunks,
  documents,
  documentVersions,
  integrityAudits,
  projects,
  qualityEvaluations,
  refinementJobs,
  similarityReports,
  users,
  writingAnalyses,
} from './schema.ts';
import { chunkDocumentText, parseRawText } from '../../server/engines/documentParser.ts';
import { analyzeFileSet } from '../../server/engines/projectAnalyzer.ts';

export async function logActivity(
  userId: string,
  moduleName: string,
  action: string,
  entityTitle: string,
  status = 'Completed'
) {
  try {
    await db.insert(activityLogs).values({
      id: newId('act'),
      userId,
      module: moduleName,
      action,
      entityTitle: entityTitle.slice(0, 240),
      status,
    });
  } catch (err) {
    console.error('Database activity log error:', err);
  }
}

export function computeNormalizedChunkVector384(text: string): number[] {
  const vec = new Array<number>(384).fill(0);
  const tokens = (text.toLowerCase().match(/[a-z0-9]{2,}/g) || []).slice(0, 400);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % 384;
    vec[idx] += 1;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < 384; i++) vec[i] = Number((vec[i] / norm).toFixed(6));
  }
  return vec;
}

export async function indexDocumentChunks(
  userId: string,
  documentId: string,
  title: string,
  rawText: string
) {
  try {
    await db.delete(corpusChunks).where(eq(corpusChunks.documentId, documentId));
    const chunks = chunkDocumentText(rawText, 160);
    if (chunks.length === 0) return;
    await db.insert(corpusChunks).values(
      chunks.slice(0, 40).map((content, idx) => {
        const vec = computeNormalizedChunkVector384(content);
        return {
          id: newId('chk'),
          userId,
          documentId,
          sourceType: 'workspace',
          title: title.slice(0, 500),
          authors: '',
          year: '',
          url: '',
          chunkIndex: idx,
          content,
          embeddingJson: JSON.stringify(vec),
          embedding: vec,
        };
      })
    );
  } catch (err) {
    console.error('Database chunk indexing failed:', err);
  }
}

export async function queryPgvectorSimilarChunks(
  userId: string,
  queryText: string,
  excludeDocumentId?: string,
  limit = 6
): Promise<Array<{ id: string; title: string; source: string; text: string }>> {
  try {
    const qVec = computeNormalizedChunkVector384(queryText.slice(0, 2000));
    const vecLiteral = `[${qVec.join(',')}]`;
    const excludeClause = excludeDocumentId
      ? sql`AND document_id IS DISTINCT FROM ${excludeDocumentId}`
      : sql``;
    const rows = await db.execute(
      sql`SELECT id, document_id, title, content FROM corpus_chunks WHERE user_id = ${userId} AND embedding IS NOT NULL ${excludeClause} ORDER BY embedding <=> ${vecLiteral}::vector LIMIT ${limit}`
    );
    const items = (rows as any)?.rows ?? [];
    return items.map((r: any) => ({
      id: String(r.document_id || r.id),
      title: String(r.title || 'Workspace Chunk'),
      source: 'Workspace pgvector Chunk',
      text: String(r.content || ''),
    }));
  } catch {
    return [];
  }
}

export async function ensureDemoWorkspaceSeeded() {
  if ((process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Demo workspace is disabled in production.');
  }
  try {
    const demoEmail = 'researcher@researchforge.ai';
    const existing = await db.select().from(users).where(eq(users.email, demoEmail)).limit(1);
    let demoUser = existing[0];

    if (!demoUser) {
      const id = newId('usr');
      const passwordHash = bcrypt.hashSync('ResearchForgeDemo!2025', 10);
      const inserted = await db
        .insert(users)
        .values({
          id,
          uid: 'demo_researcher_uid',
          email: demoEmail,
          name: 'Dr. Elena Vance',
          institution: 'Center for Computational Research & AI Integrity',
          role: 'Demo Workspace',
          passwordHash,
          authProvider: 'demo',
          consentAnalytics: true,
          consentRetention: true,
        })
        .returning();
      demoUser = inserted[0];
    }

    const existingDocs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.userId, demoUser.id))
      .limit(1);
    if (existingDocs.length > 0) {
      return demoUser;
    }

    const demoFiles = [
      {
        path: 'requirements.txt',
        content: 'torch==2.3.0\nfederated-core==0.4.2\nscikit-learn==1.5.0\nfastapi==0.111.0\n',
      },
      {
        path: 'src/models/ecg_resnet.py',
        content: `import torch
import torch.nn as nn

class Residual1DCNN(nn.Module):
    def __init__(self, num_classes=5):
        super().__init__()
        self.conv1 = nn.Conv1d(1, 64, kernel_size=7, padding=3)
        self.fc = nn.Linear(64, num_classes)
# random_state=42
`,
      },
      {
        path: 'src/federated/server.py',
        content: `from fastapi import FastAPI
app = FastAPI()

@app.post("/api/federated/round")
def aggregate_fedavg(weights: list):
    return {"algorithm": "FedAvg", "rounds": 30}
`,
      },
      {
        path: 'src/db/schema.sql',
        content: `CREATE TABLE client_telemetry (
  client_id TEXT PRIMARY KEY,
  hospital_region TEXT,
  f1_score REAL,
  round_number INTEGER
);`,
      },
      {
        path: 'eval/mit_bih_results.json',
        content: JSON.stringify({
          dataset: 'MIT-BIH',
          macro_f1: 0.914,
          auroc: 0.968,
          accuracy: 94.2,
          communication_rounds: 30,
        }),
      },
      {
        path: 'tests/test_ecg_pipeline.py',
        content: `def test_fedavg_convergence():
    assert True
`,
      },
    ];

    const projectAnalysis = analyzeFileSet('Federated-ECG-Classifier', demoFiles);
    const projId = newId('proj');
    await db.insert(projects).values({
      id: projId,
      userId: demoUser.id,
      title: 'Federated-ECG-Classifier (PyTorch + FastAPI)',
      description: 'Privacy-preserving decentralized 12-lead ECG arrhythmia classifier across 6 clinical nodes.',
      domain: 'Biomedical ML & Federated Learning',
      sourceType: 'zip_archive',
      sourceUrl: 'demo://federated-ecg-classifier.zip',
      status: 'analyzed',
      analysisJson: JSON.stringify(projectAnalysis),
    });

    const sampleManuscript = `Abstract
This study introduces a decentralized federated learning framework for cardiac arrhythmia detection across six hospital nodes without sharing raw electrocardiogram waveforms. Using a Residual1DCNN backbone trained with FedAvg over MIT-BIH records, the system preserves patient privacy while achieving competitive macro-F1 performance of 0.914 and 94.2% accuracy [1].

I. Introduction
Clinical ECG datasets remain siloed across regional hospitals due to strict privacy governance [1]. Traditional centralized training aggregates sensitive patient telemetry in a single repository, creating compliance exposure. Furthermore, conventional centralized pipelines frequently fail to preserve institutional autonomy. Moreover, deep learning architectures facilitate standardized pattern extraction across distributed clinical cohorts. Consequently, collaborative diagnostics can achieve enhanced reliability.

II. Proposed Methodology
Our pipeline applies bandpass filtering ($0.5\\text{ Hz} - 40\\text{ Hz}$) and R-peak segmentation prior to local training using a compact Residual1DCNN architecture. At each federation round $t$, hospital nodes update local parameters via Adam optimization with differential weight scaling: $w_{t+1} = \\sum_{k=1}^{K} \\frac{n_k}{n} w_{t+1}^k$ [1], [2].

III. Experimental Setup & Results
We evaluate across MIT-BIH benchmark partitions (48 ambulatory recordings) using 5-fold cross-validation and fixed random_state=42. Across 30 communication rounds, the federated Residual1DCNN yields a macro-F1 score of 0.914, AUROC of 0.968, and 94.2% classification accuracy, closely tracking a centralized baseline while maintaining zero raw waveform egress.

IV. Conclusion
Federated learning enables multi-institutional ECG modeling without raw data centralization. Future work will examine personalized local calibration layers and asynchronous node participation.

References
[1] H. B. McMahan et al., "Communication-Efficient Learning of Deep Networks from Decentralized Data," AISTATS, 2017. DOI: 10.48550/arXiv.1602.05629
[2] A. Vaswani et al., "Attention Is All You Need," Advances in Neural Information Processing Systems (NeurIPS), 2017. DOI: 10.48550/arXiv.1706.03762`;

    const parsedDoc = parseRawText(sampleManuscript, 'ieee');
    const docId = newId('doc');
    await db.insert(documents).values({
      id: docId,
      userId: demoUser.id,
      projectId: projId,
      title: 'Federated 1D-ResNet for Privacy-Preserving Arrhythmia Classification',
      format: 'ieee',
      citationStyle: 'IEEE',
      rawText: sampleManuscript,
      sectionsJson: JSON.stringify(parsedDoc.sections),
      referencesJson: JSON.stringify(parsedDoc.references),
      metadataJson: JSON.stringify({
        citationsFound: parsedDoc.citationsFound,
        equationsFound: parsedDoc.equationsFound,
      }),
      wordCount: parsedDoc.wordCount,
      status: 'needs_review',
    });

    await db.insert(documentVersions).values({
      id: newId('ver'),
      documentId: docId,
      versionNumber: 1,
      label: 'Initial Imported Draft',
      sectionsJson: JSON.stringify(parsedDoc.sections),
      rawText: sampleManuscript,
    });

    await indexDocumentChunks(
      demoUser.id,
      docId,
      'Federated 1D-ResNet for Privacy-Preserving Arrhythmia Classification',
      sampleManuscript
    );

    await logActivity(
      demoUser.id,
      'Workspace',
      'Initialized sample project and IEEE manuscript',
      'Federated 1D-ResNet for Privacy-Preserving Arrhythmia Classification',
      'Completed'
    );

    return demoUser;
  } catch (error) {
    console.error('Database query failed in ensureDemoWorkspaceSeeded:', error);
    throw new Error('Failed to initialize demo researcher workspace.', { cause: error });
  }
}

export async function getUserDashboardData(userId: string) {
  try {
    const [docCountRows, projCountRows, pendingAuditRows, latestCits, recentAct, recentDocs, recentAud] =
      await Promise.all([
        db.select({ c: sql<number>`count(*)::int` }).from(documents).where(eq(documents.userId, userId)),
        db.select({ c: sql<number>`count(*)::int` }).from(projects).where(eq(projects.userId, userId)),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(documents)
          .where(and(eq(documents.userId, userId), ne(documents.status, 'verified'))),
        db
          .select({ summaryJson: citationChecks.summaryJson })
          .from(citationChecks)
          .where(eq(citationChecks.userId, userId))
          .orderBy(desc(citationChecks.createdAt))
          .limit(10),
        db
          .select()
          .from(activityLogs)
          .where(eq(activityLogs.userId, userId))
          .orderBy(desc(activityLogs.createdAt))
          .limit(10),
        db
          .select({
            id: documents.id,
            title: documents.title,
            format: documents.format,
            word_count: documents.wordCount,
            status: documents.status,
            updated_at: documents.updatedAt,
          })
          .from(documents)
          .where(eq(documents.userId, userId))
          .orderBy(desc(documents.updatedAt))
          .limit(6),
        db
          .select({
            id: integrityAudits.id,
            title: integrityAudits.title,
            overall_status: integrityAudits.overallStatus,
            created_at: integrityAudits.createdAt,
          })
          .from(integrityAudits)
          .where(eq(integrityAudits.userId, userId))
          .orderBy(desc(integrityAudits.createdAt))
          .limit(5),
      ]);

    let verifiedCitations = 0;
    let totalCitations = 0;
    for (const row of latestCits) {
      const s = JSON.parse(row.summaryJson || '{}');
      verifiedCitations += s.verifiedCount ?? 0;
      totalCitations += s.totalReferences ?? 0;
    }

    return {
      stats: {
        documentsProcessed: docCountRows[0]?.c ?? 0,
        researchProjects: projCountRows[0]?.c ?? 0,
        pendingAudits: pendingAuditRows[0]?.c ?? 0,
        citationVerification: { verified: verifiedCitations, total: totalCitations },
      },
      recentActivity: recentAct.map((a) => ({
        id: a.id,
        module: a.module,
        action: a.action,
        entity_title: a.entityTitle,
        status: a.status,
        created_at: a.createdAt.toISOString(),
      })),
      recentDocuments: recentDocs.map((d) => ({
        ...d,
        updated_at: d.updated_at.toISOString(),
      })),
      recentAudits: recentAud.map((a) => ({
        ...a,
        created_at: a.created_at.toISOString(),
      })),
    };
  } catch (error) {
    console.error('Database query failed in getUserDashboardData:', error);
    throw new Error('Failed to load workspace dashboard metrics.', { cause: error });
  }
}

export async function clearUserWorkspaceData(userId: string) {
  try {
    await db.delete(refinementJobs).where(eq(refinementJobs.userId, userId));
    await db.delete(citations).where(eq(citations.userId, userId));
    await db.delete(corpusChunks).where(eq(corpusChunks.userId, userId));
    await db.delete(similarityReports).where(eq(similarityReports.userId, userId));
    await db.delete(writingAnalyses).where(eq(writingAnalyses.userId, userId));
    await db.delete(citationChecks).where(eq(citationChecks.userId, userId));
    await db.delete(qualityEvaluations).where(eq(qualityEvaluations.userId, userId));
    await db.delete(integrityAudits).where(eq(integrityAudits.userId, userId));
    await db.delete(activityLogs).where(eq(activityLogs.userId, userId));
    await db.delete(documents).where(eq(documents.userId, userId));
    await db.delete(projects).where(eq(projects.userId, userId));
  } catch (error) {
    console.error('Database query failed in clearUserWorkspaceData:', error);
    throw new Error('Failed to purge workspace data.', { cause: error });
  }
}
