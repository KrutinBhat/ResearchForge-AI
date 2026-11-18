import { Link } from 'react-router-dom';
import { ArrowRight, Check, ShieldAlert, FileCheck2, GitCompare } from 'lucide-react';

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-40">
        <div className="max-w-[1200px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <Link
            to="/"
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            ResearchForge AI
          </Link>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
            <a href="#workflows" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Workflows
            </a>
            <a href="#modules" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Modules
            </a>
            <a href="#verification" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Verification
            </a>
            <a href="#architecture" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
              Architecture
            </a>
          </nav>

          <div className="shrink-0">
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-800 rounded-lg hover:bg-blue-900 transition-colors whitespace-nowrap shrink-0"
            >
              <span>Open Workbench</span>
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Split */}
      <section className="border-b border-slate-200 bg-slate-50/60">
        <div className="max-w-[1200px] mx-auto px-6 py-16 lg:py-24 grid grid-cols-1 lg:grid-cols-12 gap-12 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center">
            <p className="text-xs font-medium text-blue-800 tracking-wide mb-3">
              Research Intelligence · Verified Evidence · Academic Integrity
            </p>
            <h1
              className="font-display font-bold tracking-tight text-slate-900 leading-[1.12] mb-5"
              style={{ fontSize: 'clamp(2.25rem, 3.8vw, 3.5rem)', textWrap: 'balance' }}
            >
              Evidence-grounded research authoring and integrity verification
            </h1>
            <p className="text-base text-slate-600 leading-relaxed mb-8 max-w-xl">
              Generate IEEE manuscripts directly from analyzed source repositories, refine existing papers while
              preserving mathematical notation and citations, and audit every claim against live Crossref, OpenAlex,
              Semantic Scholar, and arXiv registries.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <Link
                to="/auth"
                className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-blue-800 rounded-lg hover:bg-blue-900 transition-colors whitespace-nowrap"
              >
                <span>Launch Research Workspace</span>
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
              <a
                href="#workflows"
                className="inline-flex items-center px-5 py-3 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                Explore Two Workflows
              </a>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="h-full min-h-[280px] rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
              <img
                src="/src/assets/images/hero_research_workbench_1795014541460.jpg"
                alt="Printed scientific manuscript sheets and structural diagrams on a researcher desk"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        </div>

        {/* Full-Width Proof Strip below Hero Split */}
        <div className="border-t border-slate-200 bg-white">
          <div className="max-w-[1200px] mx-auto px-6 py-6 grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <div className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">9 Modules</div>
              <div className="text-xs text-slate-500 mt-1">Unified integrity pipeline</div>
            </div>
            <div>
              <div className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">4 Registries</div>
              <div className="text-xs text-slate-500 mt-1">Crossref · OpenAlex · S2 · arXiv</div>
            </div>
            <div>
              <div className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">7 Formats</div>
              <div className="text-xs text-slate-500 mt-1">PDF · DOCX · DOC · TXT · MD · RTF · TeX</div>
            </div>
            <div>
              <div className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">Static Only</div>
              <div className="text-xs text-slate-500 mt-1">Zero untrusted code execution</div>
            </div>
          </div>
        </div>
      </section>

      {/* Two Primary Workflows */}
      <section id="workflows" className="max-w-[1200px] mx-auto px-6 py-20 border-b border-slate-200">
        <div className="max-w-2xl mb-12">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mb-3">
            Two primary research workflows
          </h2>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            Whether authoring a new manuscript from an engineering codebase or polishing an existing draft for
            journal submission, every stage preserves verifiable provenance.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="p-8 rounded-xl border border-slate-200 bg-white">
            <div className="text-xs font-medium text-blue-800 mb-2">01. Creation Workflow</div>
            <h3 className="font-display text-xl font-semibold text-slate-900 mb-3">
              Project-to-Paper Architecture Synthesis
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed mb-6">
              Upload a project ZIP archive or link a public GitHub repository. Static AST and schema extractors map
              models, API routes, SQL tables, dependencies, and evaluation JSONs before generating a 12-section IEEE
              draft that flags missing empirical inputs instead of inventing data.
            </p>
            <ul className="space-y-2.5 text-sm text-slate-700">
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-blue-800 mt-0.5 shrink-0" aria-hidden="true" />
                <span>Static multi-language code extraction with ZIP path-traversal protection</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-blue-800 mt-0.5 shrink-0" aria-hidden="true" />
                <span>Automated cross-check flagging claims absent from source code</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-blue-800 mt-0.5 shrink-0" aria-hidden="true" />
                <span>IEEE and APA studio editing with binary DOCX, PDF, and LaTeX export</span>
              </li>
            </ul>
          </div>

          <div className="p-8 rounded-xl border border-slate-200 bg-white">
            <div className="text-xs font-medium text-indigo-700 mb-2">02. Refinement Workflow</div>
            <h3 className="font-display text-xl font-semibold text-slate-900 mb-3">
              Academic Paper Refinement & Integrity Audit
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed mb-6">
              Ingest existing PDF, DOCX, Markdown, RTF, or LaTeX manuscripts. Run section-aware clarity and technical
              precision refinement with side-by-side diff inspection, equation/citation lock verification, multi-layer
              similarity checks, and live reference validation.
            </p>
            <ul className="space-y-2.5 text-sm text-slate-700">
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-indigo-700 mt-0.5 shrink-0" aria-hidden="true" />
                <span>5 scholarly refinement modes with automated citation & math preservation check</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-indigo-700 mt-0.5 shrink-0" aria-hidden="true" />
                <span>Exact, n-gram, fuzzy Dice, TF-IDF cosine, and BM25 similarity layers</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-indigo-700 mt-0.5 shrink-0" aria-hidden="true" />
                <span>Transparent linguistic telemetry without false-claim detector evasion</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Asymmetric Bento of Flagship Capabilities */}
      <section id="modules" className="max-w-[1200px] mx-auto px-6 py-20 border-b border-slate-200">
        <div className="max-w-2xl mb-12">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mb-3">
            Nine interconnected intelligence engines
          </h2>
          <p className="text-sm sm:text-base text-slate-600">
            Every analytical module produces structured, auditable evidence persisted in your research workspace.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white overflow-hidden grid grid-cols-1 md:grid-cols-2">
            <div className="p-8 flex flex-col justify-between">
              <div>
                <div className="text-xs font-medium text-slate-500 mb-2">Module 09 · Dedicated Studio</div>
                <h3 className="font-display text-xl font-semibold text-slate-900 mb-3">
                  Paper Humanization & Academic Refinement
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Asynchronous processing pipeline from format detection and section segmentation through scholarly
                  restructuring, meaning-retention scoring, and side-by-side diff approval.
                </p>
              </div>
              <div className="pt-6 text-xs text-slate-500">
                Preserves LaTeX math · Locks reference indices · Exports DOCX & PDF
              </div>
            </div>
            <div className="min-h-[220px] bg-slate-100">
              <img
                src="/src/assets/images/refinement_editorial_proofs_1795014541521.jpg"
                alt="Editorial manuscript proof marks on cotton paper"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-8 flex flex-col justify-between">
            <div>
              <div className="text-xs font-medium text-slate-500 mb-2">Module 04 · Live APIs</div>
              <h3 className="font-display text-xl font-semibold text-slate-900 mb-3">
                Citation Intelligence Engine
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Queries Crossref DOIs, OpenAlex, Semantic Scholar, and arXiv in real time to verify authors,
                publication years, and titles—flagging potentially fabricated or orphaned entries.
              </p>
            </div>
            <div className="pt-6 text-xs text-slate-500">IEEE & APA formatters · Claim relevance</div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-8 flex flex-col justify-between">
            <div>
              <div className="text-xs font-medium text-slate-500 mb-2">Modules 02 & 03 · NLP & IR</div>
              <h3 className="font-display text-xl font-semibold text-slate-900 mb-3">
                Similarity & Writing Telemetry
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Combines 3-gram shingling, Dice fuzzy matching, TF-IDF cosine, and BM25 with Fano burstiness, lexical
                diversity, bigram perplexity proxy, and a transparent classifier benchmark.
              </p>
            </div>
            <div className="pt-6 text-xs text-slate-500">Explicit corpus scope · Precision/Recall/F1</div>
          </div>

          <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white overflow-hidden grid grid-cols-1 md:grid-cols-2">
            <div className="min-h-[220px] bg-slate-100 order-2 md:order-1">
              <img
                src="/src/assets/images/architecture_citation_graph_1795014540777.jpg"
                alt="Isometric software architecture and citation graph diagram"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="p-8 flex flex-col justify-between order-1 md:order-2">
              <div>
                <div className="text-xs font-medium text-slate-500 mb-2">Modules 06 & 08 · Static Cross-Check</div>
                <h3 className="font-display text-xl font-semibold text-slate-900 mb-3">
                  Technical Project-to-Paper Audit
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Detects models or accuracy metrics claimed in prose that lack corresponding PyTorch/Scikit-learn
                  definitions or evaluation JSON artifacts in the source repository.
                </p>
              </div>
              <div className="pt-6 text-xs text-slate-500">
                Verified · Needs review · Unverified · Not evaluated
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Integrity & Limitations */}
      <section id="verification" className="max-w-[1200px] mx-auto px-6 py-20 border-b border-slate-200">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="p-6 rounded-xl border border-slate-200 bg-slate-50/70">
            <ShieldAlert className="w-5 h-5 text-blue-800 mb-3" aria-hidden="true" />
            <h3 className="font-display text-base font-semibold text-slate-900 mb-2">
              Honest Scope & Limitations
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Similarity reports explicitly disclose indexed workspace and arXiv corpus boundaries rather than claiming
              Turnitin equivalence. Stylometric analysis reports prose observations without making definitive authorship
              accusations.
            </p>
          </div>
          <div className="p-6 rounded-xl border border-slate-200 bg-slate-50/70">
            <FileCheck2 className="w-5 h-5 text-blue-800 mb-3" aria-hidden="true" />
            <h3 className="font-display text-base font-semibold text-slate-900 mb-2">
              Zero Fabricated Evidence
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              The Paper Generator refuses to invent experimental accuracy numbers or fake DOIs. When benchmark artifacts
              are absent, it inserts explicit input requests for the researcher.
            </p>
          </div>
          <div id="architecture" className="p-6 rounded-xl border border-slate-200 bg-slate-50/70">
            <GitCompare className="w-5 h-5 text-blue-800 mb-3" aria-hidden="true" />
            <h3 className="font-display text-base font-semibold text-slate-900 mb-2">
              Local + Gemini Modular Runtime
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Core IR, stylometric, citation registry, static AST, and structural refinement engines run locally with
              SQLite persistence, paired with optional server-side Gemini synthesis.
            </p>
          </div>
        </div>
      </section>

      {/* Quiet Footer */}
      <footer className="bg-white py-10">
        <div className="max-w-[1200px] mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div className="font-display font-semibold text-slate-800">ResearchForge AI</div>
          <div>Academic Integrity & Research Intelligence Platform</div>
          <div className="flex items-center gap-6">
            <Link to="/auth" className="hover:text-slate-900">
              Sign in
            </Link>
            <a href="/api/docs/openapi.json" target="_blank" rel="noreferrer" className="hover:text-slate-900">
              OpenAPI Spec
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
