import { GoogleGenAI } from '@google/genai';
import { ParsedSection } from './documentParser';
import { SimilarityAnalysisResult } from './similarityEngine';
import { WritingAnalysisResult } from './writingAnalyzer';
import { CitationAuditResult } from './citationEngine';
import { PaperCodeCrossCheckFinding } from './projectAnalyzer';

export type AuditClassification = 'Verified' | 'Needs review' | 'Unverified' | 'Not evaluated';

export interface QualityDimension {
  dimension: string;
  status: 'Strong' | 'Adequate' | 'Needs Improvement' | 'Missing';
  evidence: string;
  why?: string;
  location?: string;
  recommendation: string;
}

export interface ResearchQualityResult {
  dimensions: QualityDimension[];
  weaknesses: string[];
  missingElements: string[];
  recommendations: string[];
  llmCritique?: string;
  methodologyNote: string;
}

export interface IntegrityFinding {
  area: string;
  classification: AuditClassification;
  summary: string;
  evidenceDetail: string;
  remediation: string;
}

export interface UnifiedIntegrityAuditResult {
  overallStatus: AuditClassification;
  counts: {
    verified: number;
    needsReview: number;
    unverified: number;
    notEvaluated: number;
  };
  findings: IntegrityFinding[];
  auditSummary: string;
}

export function evaluateResearchQuality(
  rawText: string,
  sections: ParsedSection[],
  references: string[],
  llmCritique?: string
): ResearchQualityResult {
  const lower = rawText.toLowerCase();
  const headings = sections.map((s) => s.heading.toLowerCase());
  const hasHeading = (pattern: RegExp) => headings.some((h) => pattern.test(h));
  const findLocation = (pattern: RegExp) =>
    sections.find((s) => pattern.test(s.heading))?.heading || 'Whole manuscript';
  const wordCount = rawText.split(/\s+/).filter(Boolean).length;

  const dimensions: QualityDimension[] = [];
  const weaknesses: string[] = [];
  const missingElements: string[] = [];
  const recommendations: string[] = [];

  const pushDim = (d: QualityDimension) => dimensions.push(d);

  // 1. Abstract Completeness
  const absSec = sections.find((s) => /abstract/i.test(s.heading));
  const absWords = absSec ? absSec.content.split(/\s+/).filter(Boolean).length : 0;
  pushDim({
    dimension: 'Abstract Completeness',
    status: absSec && absWords >= 60 ? 'Strong' : absSec ? 'Adequate' : 'Missing',
    evidence: absSec ? `Abstract present (${absWords} words).` : 'No dedicated Abstract section detected.',
    why: 'Reviewers screen problem, method, and headline result completeness from the abstract first.',
    location: absSec ? absSec.heading : 'Manuscript Header',
    recommendation: absSec ? 'Verify abstract reports objective, method, dataset, and measured result.' : 'Add a concise 120-200 word structured Abstract.',
  });

  // 2. Problem Definition
  const hasProblem = hasHeading(/problem|introduction/) && /(challenge|problem|limitation|bottleneck|silo|gap)/i.test(rawText);
  pushDim({
    dimension: 'Problem Definition',
    status: hasProblem ? 'Strong' : 'Needs Improvement',
    evidence: hasProblem ? 'Explicit problem motivation and bottlenecks identified.' : 'Problem statement lacks explicit operational constraints.',
    why: 'Clear boundary conditions prevent ill-posed evaluations.',
    location: findLocation(/problem|introduction/i),
    recommendation: hasProblem ? 'Ensure problem boundaries state assumptions explicitly.' : 'Add a dedicated Problem Statement specifying inputs, constraints, and failure modes.',
  });

  // 3. Research Gap & Novelty
  const hasGap = /(however|existing (?:methods|approaches|systems)|gap|unlike prior|to address this)/i.test(rawText);
  pushDim({
    dimension: 'Research Gap & Novelty',
    status: hasGap ? 'Adequate' : 'Needs Improvement',
    evidence: hasGap ? 'Manuscript contrasts proposed work against limitations of prior approaches.' : 'No explicit comparison contrasting limitations of prior art.',
    why: 'Novelty requires isolating what prior peer-reviewed baselines fail to resolve.',
    location: findLocation(/introduction|related|literature/i),
    recommendation: hasGap ? 'Quantify the delta against the strongest cited baseline.' : 'Articulate the exact gap left unresolved by prior literature.',
  });

  // 4. Literature Review Completeness
  const hasLit = hasHeading(/literature|related work/);
  pushDim({
    dimension: 'Literature Review Completeness',
    status: hasLit && references.length >= 6 ? 'Strong' : references.length >= 2 ? 'Adequate' : 'Missing',
    evidence: `${references.length} bibliographic references parsed; dedicated Literature Review ${hasLit ? 'present' : 'absent'}.`,
    why: 'Sufficient baseline coverage demonstrates familiarity with the subfield.',
    location: findLocation(/literature|related work/i),
    recommendation: hasLit ? 'Confirm coverage of recent peer-reviewed baselines (last 3-5 years).' : 'Add a structured Related Work section contrasting comparative baselines.',
  });

  // 5. Methodological Soundness
  const hasMethod = hasHeading(/method|approach|architecture/);
  pushDim({
    dimension: 'Methodological Soundness',
    status: hasMethod && wordCount > 250 ? 'Strong' : hasMethod ? 'Adequate' : 'Missing',
    evidence: hasMethod ? 'Methodology/Architecture section present.' : 'No explicit Methodology or System Architecture section detected.',
    why: 'Methods must allow independent re-implementation without ambiguity.',
    location: findLocation(/method|approach|architecture/i),
    recommendation: hasMethod ? 'Specify algorithmic complexity and hyperparameter rationales.' : 'Add a step-by-step Methodology section detailing equations and architecture.',
  });

  // 6. Dataset Documentation
  const hasDataset = /(dataset|corpus|mit-bih|mnist|benchmark|samples|train\/test|split|partition)/i.test(rawText);
  pushDim({
    dimension: 'Dataset Documentation',
    status: hasDataset ? 'Adequate' : 'Missing',
    evidence: hasDataset ? 'Dataset or partitioning references found in text.' : 'No explicit dataset provenance, sample counts, or split protocol documented.',
    why: 'Undocumented splits risk train/test leakage or non-reproducible baselines.',
    location: findLocation(/experiment|dataset|setup/i),
    recommendation: hasDataset ? 'Report exact sample counts, class balance, and license.' : 'Document dataset provenance, preprocessing, and train/val/test partitions.',
  });

  // 7. Experimental Design & Metrics
  const hasMetrics = /(f1|accuracy|auroc|precision|recall|rmse|mae|bleu|latency|mrr)/i.test(rawText);
  pushDim({
    dimension: 'Experimental Design & Metrics',
    status: hasHeading(/experiment|result|evaluation/) && hasMetrics ? 'Strong' : hasMetrics ? 'Adequate' : 'Needs Improvement',
    evidence: hasMetrics ? 'Quantitative evaluation metrics referenced in manuscript.' : 'No standardized quantitative metrics identified.',
    why: 'Domain-standard metrics substantiate claims objectively.',
    location: findLocation(/experiment|result|evaluation/i),
    recommendation: hasMetrics ? 'Include variance or confidence intervals across random seeds.' : 'Define primary evaluation metrics aligned with your task (e.g., F1, AUROC, MRR).',
  });

  // 8. Statistical Significance & Ablations
  const hasStats = /(p-value|confidence interval|standard deviation|ablation|significance|bootstrap|cross-validation)/i.test(lower);
  pushDim({
    dimension: 'Statistical Significance & Ablations',
    status: hasStats ? 'Adequate' : 'Needs Improvement',
    evidence: hasStats ? 'Dispersion, ablation, or cross-validation terminology detected.' : 'No variance, p-value, or ablation study terminology detected.',
    why: 'Single-run point estimates cannot rule out random seed noise.',
    location: findLocation(/result|evaluation|discussion/i),
    recommendation: 'Add ablation studies isolating each component contribution and report multi-seed variance.',
  });

  // 9. Results Consistency
  const hasDiscussion = hasHeading(/result|discussion|evaluation/);
  pushDim({
    dimension: 'Results Consistency',
    status: hasDiscussion ? 'Adequate' : 'Missing',
    evidence: hasDiscussion ? 'Results/Discussion section present.' : 'Dedicated Results and Discussion section not detected.',
    why: 'Claims in Abstract/Conclusion must match values reported in Results tables.',
    location: findLocation(/result|discussion/i),
    recommendation: 'Cross-verify that every metric stated in the Abstract exactly matches the Results tables.',
  });

  // 10. Limitations & Scope Boundaries
  const hasLimitations = /(limitation|threat|future work|future scope|open for future|not evaluated)/i.test(lower);
  pushDim({
    dimension: 'Limitations & Scope Boundaries',
    status: hasLimitations ? 'Adequate' : 'Missing',
    evidence: hasLimitations ? 'Manuscript acknowledges constraints or future scope.' : 'No explicit discussion of methodological limitations or validity threats.',
    why: 'Transparent boundary conditions protect scientific credibility.',
    location: findLocation(/limitation|discussion|conclusion|future/i),
    recommendation: 'Include an explicit Limitations subsection discussing failure cases and scope boundaries.',
  });

  // 11. Reproducibility
  const hasRepro = /(seed|hyperparameter|github|repository|learning rate|batch size|epoch|hardware|gpu)/i.test(lower);
  pushDim({
    dimension: 'Reproducibility',
    status: hasRepro ? 'Adequate' : 'Needs Improvement',
    evidence: hasRepro ? 'Reproducibility details (seeds, configs, or environment) mentioned.' : 'Missing random seeds, compute environment, or configuration specification.',
    why: 'Independent verification depends on deterministic configs and dependency pins.',
    location: findLocation(/setup|implementation|method/i),
    recommendation: 'Publish exact dependency versions, random seeds, and hardware specs.',
  });

  // 12. Ethical & Integrity Disclosure
  const hasEthics = /(ethic|privacy|bias|consent|de-identif|irb|confidential|limitation)/i.test(lower);
  pushDim({
    dimension: 'Ethics & Data Governance',
    status: hasEthics ? 'Adequate' : 'Needs Improvement',
    evidence: hasEthics ? 'Privacy/ethics or governance considerations referenced.' : 'No explicit ethical/privacy or bias mitigation statement found.',
    why: 'Empirical software/ML papers benefit from explicit data governance disclosures.',
    location: findLocation(/discussion|conclusion|abstract/i),
    recommendation: 'Document privacy safeguards, data anonymization, or misuse risk mitigations where applicable.',
  });

  // 13. Citation Quality
  pushDim({
    dimension: 'Citation Quality',
    status: references.length >= 6 ? 'Strong' : references.length >= 4 ? 'Adequate' : 'Needs Improvement',
    evidence: `${references.length} reference entries detected.`,
    why: 'Claims relying on prior art must map cleanly to verifiable bibliographic entries.',
    location: 'References',
    recommendation: 'Run Citation Intelligence verification to confirm DOIs, years, and claim alignment.',
  });

  for (const d of dimensions) {
    if (d.status === 'Missing') {
      missingElements.push(`${d.dimension}: ${d.evidence}`);
      recommendations.push(d.recommendation);
    } else if (d.status === 'Needs Improvement') {
      weaknesses.push(`${d.dimension}: ${d.evidence}`);
      recommendations.push(d.recommendation);
    }
  }

  return {
    dimensions,
    weaknesses,
    missingElements,
    recommendations: Array.from(new Set(recommendations)),
    llmCritique,
    methodologyNote:
      '13-dimension structural and evidentiary rubric derived directly from manuscript sections, citations, and experimental disclosures—without fabricated acceptance scores.',
  };
}

export async function generateOptionalReviewerCritique(rawText: string): Promise<string | undefined> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return undefined;
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
    const res = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Provide a concise, constructive peer-reviewer critique (3 bullet points max) focusing strictly on methodological gaps, missing controls, or clarity issues in this excerpt:\n\n${rawText.slice(0, 6000)}`,
      config: {
        systemInstruction: 'You are an objective academic peer reviewer. Never invent metrics or assign arbitrary numeric paper ratings.',
      },
    });
    return res.text?.trim();
  } catch {
    return undefined;
  }
}

export function buildIntegrityAudit(params: {
  similarity?: SimilarityAnalysisResult | null;
  citations?: CitationAuditResult | null;
  writing?: WritingAnalysisResult | null;
  quality?: ResearchQualityResult | null;
  codeCrossCheck?: PaperCodeCrossCheckFinding[] | null;
}): UnifiedIntegrityAuditResult {
  const findings: IntegrityFinding[] = [];

  // 1. Textual Similarity
  if (params.similarity) {
    const sim = params.similarity;
    const cls: AuditClassification =
      sim.uncitedFlagCount > 0 || sim.exactMatchPercent > 15 ? 'Needs review' : 'Verified';
    findings.push({
      area: 'Textual Similarity & Source Overlap',
      classification: cls,
      summary: `${sim.overallSimilarityPercent}% composite overlap (${sim.uncitedFlagCount} potentially uncited passage(s)).`,
      evidenceDetail: sim.corpusCoverage.limitationNotice,
      remediation:
        sim.uncitedFlagCount > 0
          ? 'Add explicit citations or paraphrase flagged passages with attribution.'
          : 'No high-risk uncited duplication detected within indexed corpus.',
    });
  } else {
    findings.push({
      area: 'Textual Similarity & Source Overlap',
      classification: 'Not evaluated',
      summary: 'Similarity engine has not been run on this document yet.',
      evidenceDetail: 'Run Module 2 (Similarity Checker) to populate.',
      remediation: 'Execute similarity scan from the Similarity Checker workspace.',
    });
  }

  // 2. Citation Verification
  if (params.citations) {
    const c = params.citations.summary;
    const cls: AuditClassification =
      c.unverifiedCount > 0
        ? 'Unverified'
        : c.needsReviewCount > 0 || c.orphanedInTextCitations.length > 0 || c.totalReferences === 0
        ? 'Needs review'
        : 'Verified';
    findings.push({
      area: 'Citation & Bibliography Verification',
      classification: cls,
      summary: `${c.verifiedCount}/${c.totalReferences} verified, ${c.needsReviewCount} needs review, ${c.unverifiedCount} unverified.`,
      evidenceDetail: `Orphaned in-text citations: ${c.orphanedInTextCitations.join(', ') || 'None'}. Duplicates: ${c.duplicateReferences?.join(', ') || 'None'}. Uncited bibliography entries: ${c.uncitedReferences.join(', ') || 'None'}.`,
      remediation:
        c.unverifiedCount > 0
          ? 'Resolve or replace unverified references flagged by Crossref/OpenAlex/arXiv.'
          : 'Reconcile any orphaned or duplicate citations before submission.',
    });
  } else {
    findings.push({
      area: 'Citation & Bibliography Verification',
      classification: 'Not evaluated',
      summary: 'Citation verification has not been executed.',
      evidenceDetail: 'Run Module 4 (Citation Intelligence) to verify DOIs and titles.',
      remediation: 'Run bibliography verification against Crossref & OpenAlex.',
    });
  }

  // 3. Technical Project-to-Paper Consistency (supports 4-state findings)
  if (params.codeCrossCheck && params.codeCrossCheck.length > 0) {
    const unsupported = params.codeCrossCheck.filter((f) => f.status === 'Unsupported');
    const review = params.codeCrossCheck.filter((f) => f.status === 'Possible' || f.status === 'Unable to verify');
    const cls: AuditClassification =
      unsupported.length > 0 ? 'Unverified' : review.length > 0 ? 'Needs review' : 'Verified';
    findings.push({
      area: 'Code-to-Paper Technical Consistency',
      classification: cls,
      summary: `${params.codeCrossCheck.length} technical cross-checks: ${unsupported.length} unsupported, ${review.length} needing review.`,
      evidenceDetail:
        unsupported[0]?.explanation ||
        review[0]?.explanation ||
        'All checked architectural and metric claims align with repository static extraction.',
      remediation:
        unsupported.length > 0
          ? 'Align manuscript model/metric statements with actual implemented source artifacts.'
          : 'Ensure evaluation JSONs and test suites remain linked to the manuscript.',
    });
  } else {
    findings.push({
      area: 'Code-to-Paper Technical Consistency',
      classification: 'Not evaluated',
      summary: 'No linked source repository cross-checked against this manuscript.',
      evidenceDetail: 'Link a ZIP archive or GitHub repository in Module 6 (Project Analyzer).',
      remediation: 'Upload project source archive to verify architectural and metric claims.',
    });
  }

  // 4. Research Methodology & Evidence Completeness
  if (params.quality) {
    const missing = params.quality.missingElements.length;
    const cls: AuditClassification = missing > 0 ? 'Needs review' : 'Verified';
    findings.push({
      area: 'Methodology & Reproducibility Completeness',
      classification: cls,
      summary: `${params.quality.dimensions.length} quality criteria audited; ${missing} missing element(s), ${params.quality.weaknesses.length} improvement item(s).`,
      evidenceDetail: params.quality.missingElements[0] || params.quality.weaknesses[0] || 'Core methodology, dataset, and metric sections are present.',
      remediation: params.quality.recommendations[0] ?? 'Review methodological assumptions and limitations.',
    });
  } else {
    findings.push({
      area: 'Methodology & Reproducibility Completeness',
      classification: 'Not evaluated',
      summary: 'Research quality rubric has not been evaluated.',
      evidenceDetail: 'Run Module 5 (Research Quality Evaluator).',
      remediation: 'Run quality assessment to audit experimental completeness.',
    });
  }

  // 5. Linguistic & Writing Consistency
  if (params.writing) {
    const highFlags = params.writing.observations.filter((o) => o.signal !== 'Balanced');
    findings.push({
      area: 'Writing Style & Linguistic Consistency',
      classification: highFlags.length >= 2 ? 'Needs review' : 'Verified',
      summary: `${highFlags.length} linguistic uniformity/repetition observation(s) noted (MATTR ${params.writing.metrics.mattr50}, Shannon entropy ${params.writing.metrics.shannonEntropyBits} bits, Fano ${params.writing.metrics.burstinessFanoFactor}).`,
      evidenceDetail: params.writing.styleConsistencyNote,
      remediation:
        highFlags.length > 0
          ? 'Consider refining repetitive transitions and uniform clause structures in Module 9.'
          : 'Natural prose cadence and lexical variation observed.',
    });
  } else {
    findings.push({
      area: 'Writing Style & Linguistic Consistency',
      classification: 'Not evaluated',
      summary: 'Linguistic pattern analysis not yet run.',
      evidenceDetail: 'Run Module 3 (AI-Writing Analyzer).',
      remediation: 'Analyze stylometric distributions and transition density.',
    });
  }

  // 6. Corpus Scope & Grounding Transparency (V1.1 6th pillar)
  const corpusDocs = params.similarity?.corpusCoverage.indexedDocuments ?? 0;
  findings.push({
    area: 'Corpus Scope & Grounding Transparency',
    classification: params.similarity ? (corpusDocs >= 4 ? 'Verified' : 'Needs review') : 'Not evaluated',
    summary: params.similarity
      ? `Similarity checked across ${corpusDocs} indexed source(s) (${params.similarity.corpusCoverage.arxivAbstractsQueried} arXiv abstracts).`
      : 'Corpus coverage awaits similarity scan execution.',
    evidenceDetail:
      params.similarity?.corpusCoverage.limitationNotice ??
      'Engine evaluates workspace manuscripts and open-access repositories; proprietary publisher feeds are excluded.',
    remediation: 'Upload related reference PDFs into your workspace corpus to maximize domain coverage.',
  });

  const verified = findings.filter((f) => f.classification === 'Verified').length;
  const needsReview = findings.filter((f) => f.classification === 'Needs review').length;
  const unverified = findings.filter((f) => f.classification === 'Unverified').length;
  const notEvaluated = findings.filter((f) => f.classification === 'Not evaluated').length;

  const overallStatus: AuditClassification =
    unverified > 0
      ? 'Unverified'
      : needsReview > 0
      ? 'Needs review'
      : verified > 0 && notEvaluated === 0
      ? 'Verified'
      : 'Needs review';

  return {
    overallStatus,
    counts: { verified, needsReview, unverified, notEvaluated },
    findings,
    auditSummary:
      overallStatus === 'Verified'
        ? 'All evaluated integrity pillars passed without unverified claims or bibliographic discrepancies.'
        : overallStatus === 'Unverified'
        ? 'Critical unverified claims or bibliographic mismatches require resolution before academic submission.'
        : 'Manuscript requires review on flagged pillars or completion of pending evaluation modules.',
  };
}

export function formatIntegrityAuditMarkdown(title: string, audit: UnifiedIntegrityAuditResult): string {
  const lines = [
    `# ResearchForge AI — Integrity & Methodology Audit`,
    ``,
    `- **Manuscript:** ${title}`,
    `- **Overall Classification:** ${audit.overallStatus}`,
    `- **Summary:** ${audit.auditSummary}`,
    `- **Counts:** ${audit.counts.verified} Verified · ${audit.counts.needsReview} Needs Review · ${audit.counts.unverified} Unverified · ${audit.counts.notEvaluated} Not Evaluated`,
    ``,
    `## Pillar Breakdown`,
    ``,
  ];
  for (const f of audit.findings) {
    lines.push(`### ${f.area} (${f.classification})`);
    lines.push(`- **Summary:** ${f.summary}`);
    lines.push(`- **Evidence:** ${f.evidenceDetail}`);
    lines.push(`- **Remediation:** ${f.remediation}`);
    lines.push(``);
  }
  return lines.join('\n');
}
