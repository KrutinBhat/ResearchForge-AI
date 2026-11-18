import { GoogleGenAI, Type } from '@google/genai';
import { ExtractedProjectAnalysis } from './projectAnalyzer';
import { extractEquations, extractInTextCitations, ParsedSection } from './documentParser';
import { contentTokens, jaccardSimilarity } from './similarityEngine';

export type RefinementMode =
  | 'Academic Clarity'
  | 'Technical Precision'
  | 'Concise Academic Writing'
  | 'Formal Research Style'
  | 'Readability Improvement';

export interface GeneratedPaperOutput {
  title: string;
  keywords: string[];
  sections: ParsedSection[];
  references: string[];
  missingInformationPrompts: string[];
  groundingSummary: string;
  paperFormat: 'IEEE' | 'APA';
  engineUsed: 'gemini-4-hydrogen' | 'local-structural';
}

export interface RefinementValidation {
  citationsPreserved: boolean;
  missingCitations: string[];
  equationsPreserved: boolean;
  missingEquations: string[];
  numbersPreserved: boolean;
  missingNumbers: string[];
  addedNumbers: string[];
  termsPreserved: boolean;
  missingTerms: string[];
  meaningRetentionScore: number;
  semanticDriftWarning: boolean;
  wordDelta: number;
  changesSummary: string[];
}

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured in the environment Secrets panel.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function fetchOpenAlexGrounding(query: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(
      `https://api.openalex.org/works?search=${encodeURIComponent(query.slice(0, 140))}&per-page=4`,
      { signal: controller.signal, headers: { 'User-Agent': 'ResearchForgeAI/1.1' } }
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as { results?: any[] };
    const refs: string[] = [];
    for (let i = 0; i < (json.results ?? []).length; i++) {
      const w = json.results![i];
      const authors = Array.isArray(w.authorships)
        ? w.authorships.slice(0, 3).map((a: any) => a.author?.display_name).filter(Boolean).join(', ')
        : 'Unknown Author(s)';
      const title = w.title || 'Untitled Work';
      const yr = w.publication_year || 'n.d.';
      const venue = w.primary_location?.source?.display_name || 'OpenAlex Indexed';
      const doi = w.doi ? ` DOI: ${String(w.doi).replace('https://doi.org/', '')}` : '';
      refs.push(`[${i + 1}] ${authors}, "${title}," ${venue}, ${yr}.${doi}`);
    }
    return refs;
  } catch {
    return [];
  }
}

export async function generateResearchPaper(params: {
  projectAnalysis?: ExtractedProjectAnalysis | null;
  title: string;
  synopsis: string;
  datasetNotes: string;
  experimentalResults: string;
  literatureNotes: string;
  paperFormat?: 'IEEE' | 'APA';
  engineMode?: 'gemini' | 'local';
}): Promise<GeneratedPaperOutput> {
  const {
    projectAnalysis,
    title,
    synopsis,
    datasetNotes,
    experimentalResults,
    literatureNotes,
    paperFormat = 'IEEE',
    engineMode = 'gemini',
  } = params;

  const missingInformationPrompts: string[] = [];
  if (!datasetNotes.trim() && (!projectAnalysis || projectAnalysis.datasetsDetected.length === 0)) {
    missingInformationPrompts.push('Dataset provenance, sample counts, and train/validation/test split ratios are missing.');
  }
  if (!experimentalResults.trim() && (!projectAnalysis || projectAnalysis.evaluationEvidence.length === 0)) {
    missingInformationPrompts.push('Verified quantitative experimental metrics (e.g., F1, accuracy, latency, baseline comparisons) are missing.');
  }

  let effectiveLiterature = literatureNotes.trim();
  let retrievedOpenAlexRefs: string[] = [];
  if (!effectiveLiterature) {
    retrievedOpenAlexRefs = await fetchOpenAlexGrounding(`${title} ${synopsis}`.trim());
    if (retrievedOpenAlexRefs.length > 0) {
      effectiveLiterature = retrievedOpenAlexRefs.join('\n');
    } else {
      missingInformationPrompts.push('Peer-reviewed baseline references for the Literature Review section were not supplied and OpenAlex was unreachable.');
    }
  }

  if (engineMode === 'local') {
    return buildLocalGroundedPaper(
      { ...params, literatureNotes: effectiveLiterature, paperFormat },
      missingInformationPrompts,
      retrievedOpenAlexRefs
    );
  }

  const ai = getAiClient();
  const evidenceContext = projectAnalysis
    ? JSON.stringify(
        {
          projectName: projectAnalysis.projectName,
          languages: projectAnalysis.languages,
          frameworks: projectAnalysis.frameworks,
          dependencies: projectAnalysis.dependencies.slice(0, 20),
          architecture: projectAnalysis.architecture,
          endpoints: projectAnalysis.endpoints.slice(0, 15),
          models: projectAnalysis.models,
          algorithms: projectAnalysis.algorithms,
          databases: projectAnalysis.databases,
          evaluationEvidence: projectAnalysis.evaluationEvidence,
          datasetsDetected: projectAnalysis.datasetsDetected,
          reproducibilityNotes: projectAnalysis.reproducibilityNotes,
        },
        null,
        2
      )
    : 'No source repository uploaded; rely strictly on user synopsis and notes.';

  const prompt = `You are a ${paperFormat} academic research paper architect.
Generate a structured ${paperFormat} research paper (Abstract, Keywords, Introduction, Literature Review, Problem Statement, Proposed Methodology, System Architecture, Experimental Setup, Results and Discussion, Conclusion, Future Scope) grounded STRICTLY in verified project evidence and user-provided inputs below.

CRITICAL INTEGRITY RULES:
1. NEVER fabricate experimental results, accuracy percentages, datasets, benchmarks, or bibliographic DOIs/references.
2. If experimental metrics, baseline literature citations, or dataset details are missing from the inputs, explicitly insert a clear marker like "[INPUT NEEDED: supply verified benchmark metrics]" rather than inventing numbers.
3. Every architectural component, model class, database table, or API endpoint named in the paper MUST come directly from the extracted project evidence or user synopsis.

FORMAT STANDARD: ${paperFormat}
PROJECT TITLE: ${title}
USER SYNOPSIS & OBJECTIVES: ${synopsis || 'Not provided'}
DATASET NOTES: ${datasetNotes || 'Not provided'}
EXPERIMENTAL RESULTS: ${experimentalResults || 'Not provided'}
LITERATURE NOTES / RETRIEVED OPENALEX REFERENCES: ${effectiveLiterature || 'Not provided'}

EXTRACTED STATIC CODE EVIDENCE:
${evidenceContext}`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      systemInstruction: `Produce rigorous, formal ${paperFormat}-style academic prose strictly grounded in supplied technical evidence. Never invent numbers or citations.`,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
          sections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                heading: { type: Type.STRING },
                content: { type: Type.STRING },
              },
            },
          },
          references: { type: Type.ARRAY, items: { type: Type.STRING } },
          missingInformationPrompts: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim());
  const refs = Array.isArray(parsed.references) && parsed.references.length > 0 ? parsed.references : retrievedOpenAlexRefs;
  return {
    title: parsed.title || title,
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    references: refs,
    missingInformationPrompts: Array.from(
      new Set([...(parsed.missingInformationPrompts ?? []), ...missingInformationPrompts])
    ),
    groundingSummary: projectAnalysis
      ? `Grounded in ${projectAnalysis.fileCount} analyzed source files (${projectAnalysis.languages.join(', ')}) and ${projectAnalysis.models.length} extracted model component(s)${retrievedOpenAlexRefs.length ? ` + ${retrievedOpenAlexRefs.length} live OpenAlex references` : ''}.`
      : `Grounded in user synopsis${retrievedOpenAlexRefs.length ? ` and ${retrievedOpenAlexRefs.length} live OpenAlex references` : ''}.`,
    paperFormat,
    engineUsed: 'gemini-4-hydrogen',
  };
}

function buildLocalGroundedPaper(
  params: {
    projectAnalysis?: ExtractedProjectAnalysis | null;
    title: string;
    synopsis: string;
    datasetNotes: string;
    experimentalResults: string;
    literatureNotes: string;
    paperFormat: 'IEEE' | 'APA';
  },
  missingInformationPrompts: string[],
  retrievedRefs: string[]
): GeneratedPaperOutput {
  const a = params.projectAnalysis;
  const modelsText = a?.models.length
    ? a.models.map((m) => `${m.name} (${m.type} in ${m.file})`).join('; ')
    : '[INPUT NEEDED: Specify implemented model or algorithmic components]';
  const stackText = a?.frameworks.length ? a.frameworks.join(', ') : a?.languages.join(', ') || 'Modular software stack';
  const evalText = params.experimentalResults.trim()
    ? params.experimentalResults.trim()
    : a?.evaluationEvidence.length
    ? a.evaluationEvidence.map((e) => `${e.source}: ${JSON.stringify(e.metrics)}`).join('; ')
    : '[INPUT NEEDED: Provide verified empirical evaluation metrics; no fabricated numbers generated.]';

  const ieeePrefixes = params.paperFormat === 'IEEE';
  const h = (roman: string, label: string) => (ieeePrefixes ? `${roman}. ${label}` : label);

  const sections: ParsedSection[] = [
    {
      id: 'sec_abstract',
      heading: 'Abstract',
      content: `${params.synopsis || `This paper documents the architecture and implementation of ${params.title}.`} Implemented using ${stackText}, the system incorporates ${modelsText}. Empirical evaluation summary: ${evalText}`,
    },
    {
      id: 'sec_keywords',
      heading: 'Keywords',
      content: [a?.languages.join(', '), a?.frameworks.join(', '), 'Software Architecture', 'Reproducible Research']
        .filter(Boolean)
        .join(', '),
    },
    {
      id: 'sec_intro',
      heading: h('I', 'Introduction'),
      content: `${params.synopsis || 'Modern research software requires transparent alignment between theoretical claims and executable system architecture.'} This work details the technical structure extracted from ${a ? `${a.fileCount} source files totaling ${a.totalLines} lines of code` : 'project documentation'}.`,
    },
    {
      id: 'sec_lit',
      heading: h('II', 'Literature Review'),
      content: params.literatureNotes.trim() || '[INPUT NEEDED: Supply peer-reviewed citations and baseline comparisons for the Literature Review.]',
    },
    {
      id: 'sec_problem',
      heading: h('III', 'Problem Statement'),
      content: `Given the domain objectives in ${params.title}, the system addresses reliable processing, reproducible execution, and empirical validation without unverified assumptions.`,
    },
    {
      id: 'sec_method',
      heading: h('IV', 'Proposed Methodology'),
      content: `Core components identified include: ${modelsText}. Algorithmic routines detected: ${a?.algorithms.join(', ') || 'See implementation modules'}.`,
    },
    {
      id: 'sec_arch',
      heading: h('V', 'System Architecture'),
      content: `Backend modules (${a?.architecture.backend.slice(0, 6).join(', ') || 'N/A'}), frontend interfaces (${a?.architecture.frontend.slice(0, 6).join(', ') || 'N/A'}), and ${a?.endpoints.length ?? 0} API endpoints coordinate data flow. Database schemas: ${a?.databases.map((d) => `${d.table}(${d.columns.join(', ')})`).join('; ') || 'None detected'}.`,
    },
    {
      id: 'sec_exp',
      heading: h('VI', 'Experimental Setup'),
      content: `Datasets: ${params.datasetNotes.trim() || a?.datasetsDetected.join(', ') || '[INPUT NEEDED: Dataset specification]'}. Reproducibility artifacts: ${a?.reproducibilityNotes.join('; ') || 'Specify seed and hardware environment'}.`,
    },
    {
      id: 'sec_results',
      heading: h('VII', 'Results and Discussion'),
      content: evalText,
    },
    {
      id: 'sec_conclusion',
      heading: h('VIII', 'Conclusion'),
      content: `${params.title} integrates ${stackText} within a modular architecture verified via ${a?.architecture.tests.length ?? 0} automated test file(s).`,
    },
    {
      id: 'sec_future',
      heading: h('IX', 'Future Scope'),
      content: 'Future work will expand ablation benchmarks, cross-domain validation, and automated continuous evaluation.',
    },
  ];

  const refs = params.literatureNotes.trim()
    ? params.literatureNotes.split('\n').filter((l) => l.trim().length > 5)
    : retrievedRefs.length > 0
    ? retrievedRefs
    : ['[INPUT NEEDED: Add verified citations using Citation Intelligence]'];

  return {
    title: params.title,
    keywords: [a?.languages[0] ?? 'Research Software', ...(a?.frameworks.slice(0, 3) ?? [])],
    sections,
    references: refs,
    missingInformationPrompts,
    groundingSummary: a
      ? `Local structural ${params.paperFormat} synthesis from ${a.fileCount} files (${a.languages.join(', ')}).`
      : `Local structural ${params.paperFormat} synthesis from user inputs.`,
    paperFormat: params.paperFormat,
    engineUsed: 'local-structural',
  };
}

function extractStandaloneNumbers(text: string): string[] {
  // Strip citation brackets like [1] or years inside parens so we focus on quantitative figures
  const cleaned = text.replace(/\[\d+(?:\s*[-,]\s*\d+)*\]/g, ' ');
  return Array.from(new Set(cleaned.match(/\b\d+(?:\.\d+)?(?:%|(?=\b))/g) ?? []));
}

export function validateRefinementPreservation(
  originalText: string,
  refinedText: string,
  preserveTerms = ''
): RefinementValidation {
  const origCites = extractInTextCitations(originalText);
  const refinedCites = new Set(extractInTextCitations(refinedText));
  const missingCitations = origCites.filter((c) => !refinedCites.has(c));

  const origEqs = extractEquations(originalText);
  const missingEquations = origEqs.filter((eq) => !refinedText.includes(eq));

  const origNums = extractStandaloneNumbers(originalText);
  const refNums = extractStandaloneNumbers(refinedText);
  const missingNumbers = origNums.filter((n) => !refNums.includes(n));
  const addedNumbers = refNums.filter((n) => !origNums.includes(n));

  const protectedList = preserveTerms
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  const refLower = refinedText.toLowerCase();
  const missingTerms = protectedList.filter((t) => !refLower.includes(t.toLowerCase()));

  const origTokens = new Set(contentTokens(originalText));
  const refTokens = new Set(contentTokens(refinedText));
  const meaningRetentionScore = Number(jaccardSimilarity(origTokens, refTokens).toFixed(3));
  const semanticDriftWarning = meaningRetentionScore < 0.35 && origTokens.size >= 8;

  const origWords = originalText.split(/\s+/).filter(Boolean).length;
  const refWords = refinedText.split(/\s+/).filter(Boolean).length;

  const changesSummary: string[] = [];
  changesSummary.push(
    missingCitations.length === 0
      ? `All ${origCites.length} citation marker(s) preserved.`
      : `Warning: ${missingCitations.length} citation marker(s) altered or omitted.`
  );
  changesSummary.push(
    missingEquations.length === 0
      ? `All ${origEqs.length} mathematical expression(s) preserved.`
      : `Warning: ${missingEquations.length} equation(s) altered.`
  );
  if (missingNumbers.length > 0 || addedNumbers.length > 0) {
    changesSummary.push(
      `Numeric check: ${missingNumbers.length} missing number(s), ${addedNumbers.length} newly introduced number(s).`
    );
  }
  if (missingTerms.length > 0) {
    changesSummary.push(`Protected terms omitted: ${missingTerms.join(', ')}.`);
  }
  changesSummary.push(`Core terminology retention ratio: ${Math.round(meaningRetentionScore * 100)}%.`);

  return {
    citationsPreserved: missingCitations.length === 0,
    missingCitations,
    equationsPreserved: missingEquations.length === 0,
    missingEquations,
    numbersPreserved: missingNumbers.length === 0 && addedNumbers.length === 0,
    missingNumbers,
    addedNumbers,
    termsPreserved: missingTerms.length === 0,
    missingTerms,
    meaningRetentionScore,
    semanticDriftWarning,
    wordDelta: refWords - origWords,
    changesSummary,
  };
}

export async function refineAcademicText(params: {
  heading: string;
  text: string;
  mode: RefinementMode;
  preserveTerms?: string;
  engineMode?: 'gemini' | 'local';
}): Promise<{ refinedText: string; validation: RefinementValidation; engineUsed: string }> {
  const { heading, text, mode, preserveTerms = '', engineMode = 'gemini' } = params;

  let refinedText = text;
  let engineUsed = 'gemini-4-hydrogen';

  if (engineMode === 'local') {
    engineUsed = 'local-structural';
    refinedText = applyDeterministicAcademicRefinement(text, mode);
  } else {
    const ai = getAiClient();
    const modeDirectives: Record<RefinementMode, string> = {
      'Academic Clarity': 'Improve sentence clarity, logical flow, and natural scholarly rhythm without altering meaning.',
      'Technical Precision': 'Sharpen technical phrasing, eliminate vague qualifiers, and enforce exact engineering terminology.',
      'Concise Academic Writing': 'Remove wordy filler phrases and redundant transitions while retaining every technical fact and metric.',
      'Formal Research Style': 'Elevate informal phrasing to peer-reviewed IEEE/journal register with objective passive/active balance.',
      'Readability Improvement': 'Vary uniform sentence lengths and improve paragraph transitions for effortless expert reading.',
    };

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Refine the following academic manuscript section under mode "${mode}".
Directive: ${modeDirectives[mode]}

STRICT PRESERVATION RULES:
- Preserve ALL citation markers verbatim (e.g., [1], [2], (Smith, 2023), \\cite{...}).
- Preserve ALL mathematical equations and inline symbols verbatim (e.g., $...$, $$...$$).
- Preserve ALL numerical metrics, dataset names, and domain terms${preserveTerms ? ` including: ${preserveTerms}` : ''}.
- NEVER invent new claims, numbers, or citations.
- Return ONLY the refined section prose, with no preamble or markdown code fences.

SECTION HEADING: ${heading}
ORIGINAL TEXT:
${text}`,
      config: {
        systemInstruction:
          'You are a senior academic copy-editor for IEEE and ACM journals. Refine prose authenticity and clarity while preserving technical accuracy, citations, and equations verbatim.',
      },
    });
    refinedText = (response.text ?? text).trim();
  }

  const validation = validateRefinementPreservation(text, refinedText, preserveTerms);
  return { refinedText, validation, engineUsed };
}

export function applyDeterministicAcademicRefinement(text: string, mode: RefinementMode): string {
  let out = text;
  const replacements: Array<[RegExp, string]> = [
    [/\bFurthermore,\s+moreover,\s*/gi, 'Furthermore, '],
    [/\bHowever,\s+it is worth noting that\s+/gi, 'However, '],
    [/\bAdditionally,\s+it is important to note that\s+/gi, 'Notably, '],
    [/\bIt is worth noting that\s+/g, 'Notably, '],
    [/\bit is worth noting that\s+/g, ''],
    [/\bIn order to\b/g, 'To'],
    [/\bin order to\b/g, 'to'],
    [/\bdue to the fact that\b/gi, 'because'],
    [/\bare frequently utilized to\b/gi, 'often'],
    [/\butilized\b/gi, 'used'],
    [/\butilize\b/gi, 'use'],
    [/\ba large number of\b/gi, 'numerous'],
    [/\bIn modern ([a-z\s]+) systems,\s*/g, 'In contemporary $1 systems, '],
    [/\bin modern ([a-z\s]+) systems,\s*/g, 'in contemporary $1 systems, '],
  ];
  for (const [pattern, rep] of replacements) {
    out = out.replace(pattern, rep);
  }
  if (mode === 'Concise Academic Writing') {
    out = out
      .replace(/\bvery\s+/gi, '')
      .replace(/\bquite\s+/gi, '')
      .replace(/\bin this paper,\s+we present\b/gi, 'We present');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\n /g, '\n').trim();
}
