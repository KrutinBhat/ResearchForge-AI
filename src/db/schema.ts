import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: varchar('id', { length: 48 }).primaryKey(),
  uid: text('uid').notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  institution: varchar('institution', { length: 255 }).notNull().default(''),
  role: varchar('role', { length: 64 }).notNull().default('Researcher'),
  passwordHash: varchar('password_hash', { length: 255 }).notNull().default(''),
  authProvider: varchar('auth_provider', { length: 32 }).notNull().default('local'),
  consentAnalytics: boolean('consent_analytics').notNull().default(false),
  consentRetention: boolean('consent_retention').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull().default(''),
  domain: varchar('domain', { length: 128 }).notNull().default('Computer Science'),
  sourceType: varchar('source_type', { length: 32 }).notNull().default('manual'),
  sourceUrl: varchar('source_url', { length: 512 }).notNull().default(''),
  status: varchar('status', { length: 32 }).notNull().default('analyzed'),
  analysisJson: text('analysis_json').notNull().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable('documents', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: varchar('project_id', { length: 48 }).references(() => projects.id, {
    onDelete: 'set null',
  }),
  title: varchar('title', { length: 255 }).notNull(),
  format: varchar('format', { length: 16 }).notNull().default('ieee'),
  citationStyle: varchar('citation_style', { length: 16 }).notNull().default('IEEE'),
  rawText: text('raw_text').notNull().default(''),
  sectionsJson: text('sections_json').notNull().default('[]'),
  referencesJson: text('references_json').notNull().default('[]'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  wordCount: integer('word_count').notNull().default(0),
  status: varchar('status', { length: 32 }).notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentVersions = pgTable('document_versions', {
  id: varchar('id', { length: 48 }).primaryKey(),
  documentId: varchar('document_id', { length: 48 })
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  label: varchar('label', { length: 128 }).notNull(),
  sectionsJson: text('sections_json').notNull(),
  rawText: text('raw_text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refinementJobs = pgTable('refinement_jobs', {
  id: varchar('id', { length: 48 }).primaryKey(),
  documentId: varchar('document_id', { length: 48 })
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  mode: varchar('mode', { length: 64 }).notNull(),
  scope: varchar('scope', { length: 32 }).notNull().default('whole_paper'),
  status: varchar('status', { length: 32 }).notNull().default('queued'),
  progress: integer('progress').notNull().default(0),
  originalSectionsJson: text('original_sections_json').notNull().default('[]'),
  refinedSectionsJson: text('refined_sections_json').notNull().default('[]'),
  metricsJson: text('metrics_json').notNull().default('{}'),
  errorMessage: text('error_message').notNull().default(''),
  retries: integer('retries').notNull().default(0),
  cancelled: boolean('cancelled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const analysisJobs = pgTable('analysis_jobs', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  jobType: varchar('job_type', { length: 64 }).notNull(),
  targetId: varchar('target_id', { length: 48 }),
  status: varchar('status', { length: 32 }).notNull().default('queued'),
  progress: integer('progress').notNull().default(0),
  payloadJson: text('payload_json').notNull().default('{}'),
  resultJson: text('result_json').notNull().default('{}'),
  errorMessage: text('error_message').notNull().default(''),
  retries: integer('retries').notNull().default(0),
  cancelled: boolean('cancelled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const corpusChunks = pgTable('corpus_chunks', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 }).references(() => users.id, { onDelete: 'cascade' }),
  documentId: varchar('document_id', { length: 48 }).references(() => documents.id, {
    onDelete: 'cascade',
  }),
  sourceType: varchar('source_type', { length: 32 }).notNull().default('workspace'),
  title: varchar('title', { length: 512 }).notNull(),
  authors: varchar('authors', { length: 512 }).notNull().default(''),
  year: varchar('year', { length: 16 }).notNull().default(''),
  url: varchar('url', { length: 512 }).notNull().default(''),
  chunkIndex: integer('chunk_index').notNull().default(0),
  content: text('content').notNull(),
  embeddingJson: text('embedding_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const citations = pgTable('citations', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  documentId: varchar('document_id', { length: 48 }).references(() => documents.id, {
    onDelete: 'cascade',
  }),
  rawReference: text('raw_reference').notNull(),
  doi: varchar('doi', { length: 255 }).notNull().default(''),
  title: varchar('title', { length: 512 }).notNull().default(''),
  authors: varchar('authors', { length: 512 }).notNull().default(''),
  year: varchar('year', { length: 16 }).notNull().default(''),
  venue: varchar('venue', { length: 255 }).notNull().default(''),
  url: varchar('url', { length: 512 }).notNull().default(''),
  verificationStatus: varchar('verification_status', { length: 64 }).notNull().default('Verification unavailable'),
  claimSupportStatus: varchar('claim_support_status', { length: 64 }).notNull().default('Evidence insufficient'),
  sourceProvider: varchar('source_provider', { length: 64 }).notNull().default('none'),
  detailsJson: text('details_json').notNull().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const similarityReports = pgTable('similarity_reports', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  documentId: varchar('document_id', { length: 48 }),
  title: varchar('title', { length: 255 }).notNull(),
  overallSimilarity: doublePrecision('overall_similarity').notNull().default(0),
  corpusCoverage: text('corpus_coverage').notNull().default(''),
  resultsJson: text('results_json').notNull().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const writingAnalyses = pgTable('writing_analyses', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  documentId: varchar('document_id', { length: 48 }),
  title: varchar('title', { length: 255 }).notNull(),
  metricsJson: text('metrics_json').notNull().default('{}'),
  observationsJson: text('observations_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const citationChecks = pgTable('citation_checks', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  documentId: varchar('document_id', { length: 48 }),
  title: varchar('title', { length: 255 }).notNull(),
  citationsJson: text('citations_json').notNull().default('[]'),
  summaryJson: text('summary_json').notNull().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const qualityEvaluations = pgTable('quality_evaluations', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  documentId: varchar('document_id', { length: 48 }),
  title: varchar('title', { length: 255 }).notNull(),
  dimensionsJson: text('dimensions_json').notNull().default('[]'),
  recommendationsJson: text('recommendations_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const integrityAudits = pgTable('integrity_audits', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: varchar('project_id', { length: 48 }),
  documentId: varchar('document_id', { length: 48 }),
  title: varchar('title', { length: 255 }).notNull(),
  overallStatus: varchar('overall_status', { length: 32 }).notNull().default('Needs review'),
  findingsJson: text('findings_json').notNull().default('[]'),
  summaryJson: text('summary_json').notNull().default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const activityLogs = pgTable('activity_logs', {
  id: varchar('id', { length: 48 }).primaryKey(),
  userId: varchar('user_id', { length: 48 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  module: varchar('module', { length: 64 }).notNull(),
  action: varchar('action', { length: 255 }).notNull(),
  entityTitle: varchar('entity_title', { length: 255 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('Completed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
  documents: many(documents),
  analysisJobs: many(analysisJobs),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  owner: one(users, { fields: [documents.userId], references: [users.id] }),
  versions: many(documentVersions),
  citations: many(citations),
}));
