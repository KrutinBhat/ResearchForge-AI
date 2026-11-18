import io
import os
import re
import subprocess
import tempfile
from typing import Any, Dict, List, Tuple

from ..core.security import validate_file_signature

SUPPORTED_EXTENSIONS = {"pdf", "docx", "doc", "txt", "md", "rtf", "tex"}

HEADING_RE = re.compile(
    r"^(?:[IVX]+\.\s+|\d+(?:\.\d+)*\.?\s+|#{1,3}\s+)?"
    r"(abstract|keywords|index terms|introduction|related work|literature review|"
    r"background|problem statement|methodology|proposed methodology|proposed approach|"
    r"system architecture|architecture|experimental setup|implementation|experiments|"
    r"results|results and discussion|evaluation|discussion|limitations|threats to validity|"
    r"conclusion|conclusions|future work|future scope|acknowledgments?|references|bibliography)\s*:?$",
    re.IGNORECASE,
)


def detect_format(filename: str, content_type: str = "") -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in SUPPORTED_EXTENSIONS:
        return ext
    if "pdf" in content_type:
        return "pdf"
    if "wordprocessingml" in content_type:
        return "docx"
    if "msword" in content_type:
        return "doc"
    if "rtf" in content_type:
        return "rtf"
    if "x-tex" in content_type:
        return "tex"
    return "txt"


def strip_latex_markup(tex: str) -> str:
    cleaned = re.sub(r"%.*$", "", tex, flags=re.MULTILINE)
    cleaned = re.sub(r"\\documentclass[\s\S]*?\\begin\{document\}", "", cleaned)
    cleaned = cleaned.replace("\\end{document}", "")
    cleaned = re.sub(r"\\title\{([^}]*)\}", r"\1\n", cleaned)
    cleaned = re.sub(r"\\author\{[^}]*\}", "", cleaned)
    cleaned = cleaned.replace("\\maketitle", "")
    cleaned = re.sub(r"\\(?:sub)*section\*?\{([^}]*)\}", r"\n\1\n", cleaned)
    cleaned = cleaned.replace("\\begin{abstract}", "\nAbstract\n").replace("\\end{abstract}", "\n")
    cleaned = re.sub(r"\\begin\{thebibliography\}[\s\S]*?\\bibitem", "\nReferences\n\\bibitem", cleaned)
    cleaned = re.sub(r"\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}", r"[\1] ", cleaned)
    cleaned = cleaned.replace("\\end{thebibliography}", "")
    cleaned = re.sub(r"\\(?:textbf|textit|emph)\{([^}]*)\}", r"\1", cleaned)
    cleaned = re.sub(r"\\cite[pt]?\{([^}]*)\}", r"[\1]", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def strip_rtf_markup(rtf: str) -> str:
    text = re.sub(r"\{\*?\\[^{}]+;\}", "", rtf)
    text = re.sub(r"\\par[d]?", "\n", text)
    text = text.replace("\\tab", "\t")
    text = re.sub(r"\\'[0-9a-fA-F]{2}", " ", text)
    text = re.sub(r"\\[a-zA-Z]+-?\d*\s?", "", text)
    text = text.replace("{", "").replace("}", "")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_equations(text: str) -> List[str]:
    display = re.findall(r"\$\$[\s\S]+?\$\$|\\begin\{equation\*?\}[\s\S]+?\\end\{equation\*?\}|\\\[[\s\S]+?\\\]", text)
    inline = re.findall(r"\$[^$\n]{2,120}\$", text)
    seen: List[str] = []
    for item in display + inline:
        s = item.strip()
        if s not in seen:
            seen.append(s)
    return seen


def extract_tables_and_figures(text: str) -> Tuple[List[Dict[str, str]], List[Dict[str, str]]]:
    tables: List[Dict[str, str]] = []
    figures: List[Dict[str, str]] = []
    for line in text.splitlines():
        s = line.strip()
        m_tbl = re.match(r"^(?:Table|TABLE)\s+([IVX\d]+)[:.\s-]+(.+)$", s)
        if m_tbl:
            tables.append({"label": f"Table {m_tbl.group(1)}", "caption": m_tbl.group(2).strip()})
        m_fig = re.match(r"^(?:Figure|Fig\.|FIGURE)\s+([IVX\d]+)[:.\s-]+(.+)$", s)
        if m_fig:
            figures.append({"label": f"Figure {m_fig.group(1)}", "caption": m_fig.group(2).strip()})

    md_tables = re.findall(r"(?:^\|.+\|\s*\n\|[\s:-]+\|\s*\n(?:\|.+\|\s*\n?)+)", text, flags=re.MULTILINE)
    for idx, block in enumerate(md_tables):
        tables.append({"label": f"Markdown Table {idx + 1}", "caption": block.splitlines()[0][:120]})
    return tables, figures


def extract_in_text_citations(text: str) -> List[str]:
    brackets = re.findall(r"\[\d+(?:\s*[-,]\s*\d+)*\]", text)
    author_year = re.findall(
        r"\([A-Z][a-zA-Z-]+(?:\s+(?:et\s+al\.|&|and)\s+[A-Z][a-zA-Z-]+)?,\s*(?:19|20)\d{2}[a-z]?\)",
        text,
    )
    latex = re.findall(r"\\cite[pt]?\{[^}]+\}", text)
    seen: List[str] = []
    for item in brackets + author_year + latex:
        s = item.strip()
        if s not in seen:
            seen.append(s)
    return seen


def chunk_document_text(text: str, max_words: int = 180, overlap_words: int = 30) -> List[Dict[str, Any]]:
    words = text.split()
    if not words:
        return []
    chunks: List[Dict[str, Any]] = []
    step = max(max_words - overlap_words, 40)
    idx = 0
    chunk_num = 0
    while idx < len(words):
        window = words[idx : idx + max_words]
        chunks.append({
            "chunkIndex": chunk_num,
            "startWord": idx,
            "endWord": idx + len(window),
            "text": " ".join(window),
        })
        if idx + max_words >= len(words):
            break
        idx += step
        chunk_num += 1
    return chunks


def _is_heading(line: str) -> bool:
    t = line.strip()
    if not t or len(t) > 95:
        return False
    if HEADING_RE.match(t) or re.match(r"^#{1,3}\s+\S+", t):
        return True
    if re.match(r"^(?:[IVX]+\.|[1-9]\.)\s+[A-Z][A-Za-z0-9\s,&:-]{2,65}$", t) and not t.endswith("."):
        return True
    return False


def segment_sections(raw_text: str) -> Tuple[List[Dict[str, str]], List[str]]:
    lines = raw_text.replace("\r\n", "\n").split("\n")
    sections: List[Dict[str, str]] = []
    ref_lines: List[str] = []
    current_heading = "Document Body"
    buffer: List[str] = []
    ref_mode = False

    for line in lines:
        stripped = line.strip()
        if _is_heading(stripped):
            clean_heading = re.sub(r"^#{1,3}\s+", "", stripped).rstrip(":")
            body = "\n".join(buffer).strip()
            if body:
                if ref_mode:
                    ref_lines.extend([l.strip() for l in buffer if l.strip()])
                else:
                    sections.append({"id": f"sec_{len(sections) + 1}", "heading": current_heading, "content": body})
            current_heading = clean_heading
            buffer = []
            ref_mode = bool(re.match(r"^(?:[IVX]+\.\s+|\d+\.\s+)?(references|bibliography)$", clean_heading, re.I))
        else:
            buffer.append(line)

    tail = "\n".join(buffer).strip()
    if tail:
        if ref_mode:
            ref_lines.extend([l.strip() for l in buffer if l.strip()])
        else:
            sections.append({"id": f"sec_{len(sections) + 1}", "heading": current_heading, "content": tail})

    references: List[str] = []
    for r in ref_lines:
        if re.match(r"^(\[\d+\]|\d+[.)])\s+", r) or not references:
            references.append(r)
        else:
            references[-1] = f"{references[-1]} {r}"

    if not sections and raw_text.strip():
        sections.append({"id": "sec_1", "heading": "Manuscript Content", "content": raw_text.strip()})

    return sections, references


def _extract_pdf_with_ocr_fallback(data: bytes) -> Tuple[str, bool, bool, int, List[str]]:
    warnings: List[str] = []
    ocr_required = False
    ocr_applied = False
    page_count = 0

    try:
        import fitz  # PyMuPDF

        doc = fitz.open(stream=data, filetype="pdf")
        if doc.needs_pass or doc.is_encrypted:
            raise ValueError("PDF is password-protected or encrypted. Decrypt the manuscript before uploading.")

        page_count = len(doc)
        pages_text = [page.get_text("text").strip() for page in doc]
        raw_text = "\n\n".join(p for p in pages_text if p).strip()

        if len(raw_text) < 40 and page_count > 0:
            try:
                import pytesseract
                from PIL import Image

                ocr_pages: List[str] = []
                for page in doc[:25]:
                    pix = page.get_pixmap(dpi=200)
                    img = Image.open(io.BytesIO(pix.tobytes("png")))
                    ocr_txt = pytesseract.image_to_string(img).strip()
                    if ocr_txt:
                        ocr_pages.append(ocr_txt)
                if ocr_pages:
                    raw_text = "\n\n".join(ocr_pages).strip()
                    ocr_applied = True
                    warnings.append(f"Applied Tesseract OCR across {len(ocr_pages)} scanned PDF page(s).")
                else:
                    ocr_required = True
                    warnings.append("PDF appears scanned and OCR yielded minimal text.")
            except Exception as exc:
                ocr_required = True
                warnings.append(f"Scanned PDF detected; Tesseract OCR unavailable in current runtime ({exc}).")
        return raw_text, ocr_required, ocr_applied, page_count, warnings
    except ValueError:
        raise
    except ImportError:
        warnings.append("PyMuPDF not installed in current runtime; plain-stream fallback used.")
        return data.decode("utf-8", errors="ignore").strip(), True, False, 0, warnings


def _extract_doc_legacy(data: bytes) -> Tuple[str, List[str]]:
    warnings: List[str] = []
    with tempfile.TemporaryDirectory() as tmpdir:
        in_path = os.path.join(tmpdir, "input.doc")
        with open(in_path, "wb") as f:
            f.write(data)
        try:
            proc = subprocess.run(
                ["soffice", "--headless", "--convert-to", "docx", "--outdir", tmpdir, in_path],
                capture_output=True,
                timeout=30,
                check=False,
            )
            out_docx = os.path.join(tmpdir, "input.docx")
            if proc.returncode == 0 and os.path.exists(out_docx):
                import docx

                document = docx.Document(out_docx)
                txt = "\n".join(p.text for p in document.paragraphs if p.text.strip()).strip()
                return txt, warnings
        except Exception:
            pass

    warnings.append("Legacy .doc binary converted with best-effort printable string extraction (LibreOffice unavailable).")
    printable = re.findall(r"[A-Za-z0-9 ,.;:()\[\]\-_'\"/%$]{6,}", data.decode("latin-1", errors="ignore"))
    return "\n".join(printable).strip(), warnings


def parse_document_bytes(data: bytes, filename: str, content_type: str = "") -> Dict[str, Any]:
    fmt = detect_format(filename, content_type)
    validate_file_signature(data, filename, expected_ext=fmt)

    warnings: List[str] = []
    ocr_required = False
    ocr_applied = False
    page_count = 0
    raw_text = ""

    if fmt == "pdf":
        raw_text, ocr_required, ocr_applied, page_count, warnings = _extract_pdf_with_ocr_fallback(data)
    elif fmt == "docx":
        try:
            import docx

            document = docx.Document(io.BytesIO(data))
            blocks = [p.text.strip() for p in document.paragraphs if p.text.strip()]
            for t_idx, table in enumerate(document.tables):
                rows = [" | ".join(cell.text.strip().replace("\n", " ") for cell in row.cells) for row in table.rows]
                if rows:
                    blocks.append(f"Table {t_idx + 1}: Extracted DOCX table\n" + "\n".join(rows))
            raw_text = "\n\n".join(blocks).strip()
        except Exception as exc:
            raise ValueError(f"Unable to parse DOCX archive: {exc}") from exc
    elif fmt == "doc":
        raw_text, warnings = _extract_doc_legacy(data)
    elif fmt == "tex":
        raw_text = strip_latex_markup(data.decode("utf-8", errors="replace"))
    elif fmt == "rtf":
        raw_text = strip_rtf_markup(data.decode("utf-8", errors="replace"))
    else:
        raw_text = data.decode("utf-8", errors="replace").strip()

    return parse_raw_text(
        raw_text,
        fmt=fmt,
        ocr_required=ocr_required,
        ocr_applied=ocr_applied,
        page_count=page_count,
        warnings=warnings,
    )


def parse_raw_text(
    raw_text: str,
    fmt: str = "txt",
    ocr_required: bool = False,
    ocr_applied: bool = False,
    page_count: int = 0,
    warnings: List[str] | None = None,
) -> Dict[str, Any]:
    sections, references = segment_sections(raw_text)
    citations = extract_in_text_citations(raw_text)
    equations = extract_equations(raw_text)
    tables, figures = extract_tables_and_figures(raw_text)
    chunks = chunk_document_text(raw_text)
    word_count = len([w for w in raw_text.split() if w])
    metadata = {
        "pageCount": page_count,
        "ocrApplied": ocr_applied,
        "ocrRequired": ocr_required,
        "tableCount": len(tables),
        "figureCount": len(figures),
        "equationCount": len(equations),
        "chunkCount": len(chunks),
        "tables": tables[:20],
        "figures": figures[:20],
    }
    return {
        "format": fmt,
        "rawText": raw_text,
        "sections": sections,
        "references": references,
        "citationsFound": citations,
        "equationsFound": equations,
        "tablesFound": tables,
        "figuresFound": figures,
        "chunks": chunks,
        "metadata": metadata,
        "wordCount": word_count,
        "ocrRequired": ocr_required,
        "ocrApplied": ocr_applied,
        "warnings": warnings or [],
    }
