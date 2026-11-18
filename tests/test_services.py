import io
import unittest
import zipfile

from app.core.security import validate_file_signature, validate_public_github_url
from app.services.citation_service import (
    detect_duplicate_references,
    evaluate_claim_support,
    extract_reference_identifiers,
    format_apa,
    format_ieee,
    reconcile_citations_and_references,
)
from app.services.document_parser import (
    chunk_document_text,
    extract_equations,
    extract_tables_and_figures,
    parse_raw_text,
    strip_latex_markup,
)
from app.services.generator_refinement_service import (
    _local_generate_draft,
    _local_refine_section,
    validate_refinement_preservation,
)
from app.services.project_analyzer_service import (
    cross_check_paper_against_code,
    extract_and_analyze_zip,
    is_safe_archive_path,
)
from app.services.quality_audit_service import (
    build_integrity_audit,
    evaluate_research_quality,
    export_audit_markdown,
)
from app.services.similarity_service import BUILTIN_CORPUS, analyze_text_similarity
from app.services.writing_service import analyze_writing_patterns


class TestResearchForgePythonServices(unittest.TestCase):
    def test_security_magic_bytes_and_github_url_guards(self):
        with self.assertRaises(ValueError):
            validate_file_signature(b"MZ\x90\x00evil", "paper.pdf", "pdf")
        with self.assertRaises(ValueError):
            validate_file_signature(b"\x7fELFbinary", "notes.txt", "txt")
        with self.assertRaises(ValueError):
            validate_file_signature(b"plain text", "fake.pdf", "pdf")
        self.assertEqual(validate_file_signature(b"%PDF-1.7\n...", "paper.pdf", "pdf"), "pdf")

        owner, repo = validate_public_github_url("https://github.com/pytorch/pytorch")
        self.assertEqual((owner, repo), ("pytorch", "pytorch"))
        with self.assertRaises(ValueError):
            validate_public_github_url("http://169.254.169.254/latest/meta-data")
        with self.assertRaises(ValueError):
            validate_public_github_url("https://evil.example.com/owner/repo")

    def test_document_parser_latex_tables_figures_and_chunks(self):
        tex = (
            "\\documentclass{IEEEtran}\n\\begin{document}\n"
            "\\section{Introduction}\nWe optimize $L = \\alpha + \\beta$ as shown in [1].\n"
            "Table 1: Benchmark throughput across nodes.\n"
            "Figure 1: System pipeline diagram.\n"
            "\\section{References}\n[1] Smith et al., 2024.\n\\end{document}"
        )
        cleaned = strip_latex_markup(tex)
        parsed = parse_raw_text(cleaned, fmt="tex")
        self.assertGreaterEqual(len(parsed["sections"]), 1)
        self.assertEqual(len(parsed["references"]), 1)
        self.assertIn("$L = \\alpha + \\beta$", extract_equations(tex))
        tables, figs = extract_tables_and_figures(cleaned)
        self.assertEqual(len(tables), 1)
        self.assertEqual(len(figs), 1)
        chunks = chunk_document_text(" ".join(["token"] * 260), max_words=100, overlap_words=20)
        self.assertGreaterEqual(len(chunks), 3)

    def test_similarity_engine_exact_paraphrase_and_paragraph_matches(self):
        copied = (
            "Modern mobile devices have access to a wealth of data suitable for learning models, "
            "which in turn can greatly improve the user experience on the device.\n\n"
            "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms [2]."
        )
        res = analyze_text_similarity(copied, BUILTIN_CORPUS)
        self.assertGreater(res["overallSimilarityPercent"], 45.0)
        self.assertGreaterEqual(res["uncitedFlagCount"], 1)
        self.assertGreaterEqual(len(res["paragraphMatches"]), 1)
        self.assertIn("not equivalent to proprietary", res["corpusCoverage"]["limitationNotice"])

    def test_writing_service_v11_metrics_and_leave_one_topic_out_benchmark(self):
        prose = (
            "Furthermore, deep neural systems leverage extensive telemetry across edge nodes. "
            "Moreover, predictive modeling achieves strong accuracy on curated workloads. "
            "Consequently, operational efficiency improves noticeably across heterogeneous clusters."
        )
        res = analyze_writing_patterns(prose)
        self.assertGreater(res["metrics"]["transitionDensityPer100Words"], 4.0)
        self.assertIn("movingAverageTTR50", res["metrics"])
        self.assertIn("shannonEntropyBits", res["metrics"])
        self.assertIn("zipfSlope", res["metrics"])
        bench = res["benchmarkEvaluation"]
        self.assertEqual(bench["sampleCount"], 24)
        self.assertEqual(len(bench["topicsCovered"]), 6)
        self.assertIn("falsePositiveRate", bench)

    def test_citation_helpers_duplicates_and_contradiction_polarity(self):
        ref = '[1] J. Doe, "Neural Graph Compression," IEEE Access, 2023, doi: 10.1109/ACCESS.2023.1234567'
        ident = extract_reference_identifiers(ref)
        self.assertEqual(ident["doi"], "10.1109/ACCESS.2023.1234567")
        self.assertEqual(ident["year"], "2023")
        self.assertIn("10.1109/ACCESS.2023.1234567", format_ieee(["J. Doe"], "Neural Graph Compression", "IEEE Access", "2023", ident["doi"]))
        self.assertIn("https://doi.org/", format_apa(["J. Doe"], "Neural Graph Compression", "IEEE Access", "2023", ident["doi"]))

        dups = detect_duplicate_references([ref, ref])
        self.assertEqual(len(dups), 1)
        rec = reconcile_citations_and_references("As shown in [1] and [3].", [ref])
        self.assertEqual(rec["missingFromBibliography"], [3])

        support = evaluate_claim_support(
            "Transformer attention improves accuracy across long sequence benchmarks",
            "Experiments demonstrate Transformer attention improves accuracy on long sequence tasks.",
        )
        self.assertEqual(support["claimStatus"], "Claim supported")

        contradict = evaluate_claim_support(
            "Federated compression improves latency accuracy significantly across mobile devices",
            "Federated compression did not improve latency accuracy and reduced mobile throughput.",
        )
        self.assertEqual(contradict["claimStatus"], "Claim contradicted")

    def test_project_analyzer_zip_slip_magic_bytes_and_4_state_crosscheck(self):
        self.assertFalse(is_safe_archive_path("../../etc/passwd"))
        self.assertFalse(is_safe_archive_path("/abs/secret.py"))
        self.assertTrue(is_safe_archive_path("src/model.py"))

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("../../evil.py", "import os")
            zf.writestr("src/train.py", "import torch\nclass GraphEncoder(nn.Module):\n    pass\n")
            zf.writestr("requirements.txt", "torch==2.4.0\nfastapi==0.115.0\n")
            zf.writestr("tests/test_train.py", "def test_ok(): assert True\n")
        analysis = extract_and_analyze_zip(buf.getvalue())
        self.assertIn("../../evil.py", analysis["skippedUnsafePaths"])
        self.assertIn("PyTorch", analysis["frameworks"])
        self.assertIn("GraphEncoder", analysis["modelsDetected"])

        cc = cross_check_paper_against_code(
            "Our PyTorch GraphEncoder uses TensorFlow and unit test suites achieving 92.4% accuracy.",
            analysis,
        )
        statuses = {f["status"] for f in cc["findings"]}
        self.assertIn("Confirmed", statuses)
        self.assertIn("Unsupported", statuses)
        self.assertIn("Unable to verify", statuses)

    def test_quality_13_dimensions_and_6_pillar_integrity_audit_markdown(self):
        short_text = (
            "Abstract: We study graph compression. Problem statement addresses memory bottlenecks. "
            "Related work [1] discusses pruning. Methodology uses GraphEncoder on CIFAR dataset. "
            "Accuracy and F1 metrics are reported with random seed reproducibility. Limitations are noted. "
            "Conclusion summarizes findings. References [1] Baseline."
        )
        short_qual = evaluate_research_quality(short_text, "Short Draft")
        self.assertEqual(len(short_qual["dimensions"]), 13)
        self.assertIn("why", short_qual["dimensions"][0])
        self.assertIn("location", short_qual["dimensions"][0])

        filler = " ".join(["empirical evaluation confirms throughput gains with baseline ablation p-value statistical confidence"] * 35)
        full_text = (
            f"{short_text} Ethical integrity, bias mitigation, and data privacy disclaimers are documented. "
            f"Architecture pipeline API modules and threats to validity and future work are discussed. {filler}"
        )
        qual = evaluate_research_quality(full_text, "Graph Paper")
        self.assertGreater(qual["overallScore"], 78.0)

        partial_audit = build_integrity_audit("Graph Paper", quality_result=qual)
        self.assertEqual(len(partial_audit["findings"]), 6)
        self.assertEqual(partial_audit["overallStatus"], "Needs review")

        full_audit = build_integrity_audit(
            "Graph Paper",
            similarity_result={"overallSimilarityPercent": 6.0, "uncitedFlagCount": 0},
            citation_result={"unverifiedCount": 0, "reconciliation": {"missingFromBibliography": [], "duplicateReferences": []}},
            quality_result=qual,
            code_crosscheck={"unsupportedClaims": 0, "alignmentPercent": 90.0},
            writing_result={"observations": []},
            refinement_result={"meaningRetained": True, "allCitationsPreserved": True, "allEquationsPreserved": True},
        )
        self.assertEqual(full_audit["overallStatus"], "Verified")
        md = export_audit_markdown(full_audit)
        self.assertIn("# ResearchForge AI Integrity Audit — Graph Paper", md)

    def test_generator_and_refinement_preservation_numbers_and_terms(self):
        draft = _local_generate_draft("Federated Edge Inference", "", "", "", "", citation_style="IEEE")
        self.assertEqual(len(draft["sections"]), 12)
        self.assertGreaterEqual(len(draft["missingInputs"]), 2)
        apa_draft = _local_generate_draft("Federated Edge Inference", "", "", "", "", citation_style="APA")
        self.assertEqual(apa_draft["format"], "APA")
        self.assertEqual(apa_draft["sections"][2]["heading"], "Introduction")

        orig = "We showed that $E = mc^2$ improves Transformer latency in [1] by 14%."
        refined = _local_refine_section(orig, "Academic Clarity")
        self.assertIn("demonstrated that", refined)
        pres = validate_refinement_preservation(orig, refined, preserve_terms="Transformer")
        self.assertTrue(pres["citationsPreserved"])
        self.assertTrue(pres["equationsPreserved"])
        self.assertTrue(pres["numbersPreserved"])
        self.assertEqual(pres["missingTerms"], [])
        self.assertTrue(pres["meaningRetained"])

        drifted = validate_refinement_preservation(
            orig,
            "We demonstrated that latency improves by 99%.",
            preserve_terms="Transformer",
        )
        self.assertFalse(drifted["citationsPreserved"])
        self.assertFalse(drifted["equationsPreserved"])
        self.assertIn("14%", drifted["missingNumbers"])
        self.assertIn("99%", drifted["addedNumbersFlagged"])
        self.assertIn("Transformer", drifted["missingTerms"])
        self.assertFalse(drifted["meaningRetained"])


if __name__ == "__main__":
    unittest.main()
