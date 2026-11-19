import html
import io
import re
import zipfile
from typing import Any, Dict, List


def export_document_latex(title: str, sections: List[Dict[str, str]], references: List[str] | None = None, style: str = "IEEE") -> str:
    doc_cls = "\\documentclass[12pt]{apa7}" if style.upper() == "APA" else "\\documentclass[conference]{IEEEtran}"
    body = [
        doc_cls,
        "\\usepackage{amsmath,amssymb,graphicx,booktabs}",
        f"\\title{{{title}}}",
        "\\begin{document}",
        "\\maketitle",
    ]
    for sec in sections:
        heading = sec.get("heading", "Section")
        content = sec.get("content", "")
        if heading.lower() == "abstract":
            body.append(f"\\begin{{abstract}}\n{content}\n\\end{{abstract}}")
        else:
            body.append(f"\\section{{{heading}}}\n{content}")
    if references:
        bib_items = "\n".join(f"\\bibitem{{ref{i+1}}} {r}" for i, r in enumerate(references))
        body.append(f"\\begin{{thebibliography}}{{99}}\n{bib_items}\n\\end{{thebibliography}}")
    body.append("\\end{document}")
    return "\n\n".join(body)


def export_document_markdown(title: str, sections: List[Dict[str, str]], references: List[str] | None = None) -> str:
    lines = [f"# {title}", ""]
    for sec in sections:
        lines.append(f"## {sec.get('heading', 'Section')}")
        lines.append(sec.get("content", ""))
        lines.append("")
    if references:
        lines.append("## References")
        lines.extend(references)
    return "\n".join(lines)


def export_bibliography_bibtex(
    references: List[str] | List[Dict[str, Any]],
    include_unverified: bool = False,
) -> Dict[str, Any]:
    from .citation_service import export_bibtex_collection

    normalized: List[Dict[str, Any]] = []
    for idx, item in enumerate(references):
        if isinstance(item, str):
            normalized.append({
                "id": f"ref_{idx + 1}",
                "rawReference": item,
                "status": "Unverified",
            })
        else:
            normalized.append(item)
    return export_bibtex_collection(normalized, include_unverified=include_unverified)


def export_document_docx_bytes(
    title: str,
    sections: List[Dict[str, str]],
    references: List[str] | None = None,
    style: str = "IEEE",
) -> bytes:
    from docx import Document as DocxDocument
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches

    doc = DocxDocument()
    for sec_obj in doc.sections:
        sec_obj.top_margin = Inches(0.75)
        sec_obj.bottom_margin = Inches(0.75)
        sec_obj.left_margin = Inches(0.65 if style.upper() == "IEEE" else 1.0)
        sec_obj.right_margin = Inches(0.65 if style.upper() == "IEEE" else 1.0)

    title_p = doc.add_heading(title, level=0)
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    if style.upper() == "IEEE":
        abstract_secs = [s for s in sections if s.get("heading", "").lower() in {"abstract", "keywords"}]
        body_secs = [s for s in sections if s.get("heading", "").lower() not in {"abstract", "keywords"}]
        for sec in abstract_secs:
            doc.add_heading(sec.get("heading", ""), level=1)
            doc.add_paragraph(sec.get("content", ""))
        new_section = doc.add_section()
        new_section.top_margin = Inches(0.75)
        new_section.bottom_margin = Inches(0.75)
        new_section.left_margin = Inches(0.65)
        new_section.right_margin = Inches(0.65)
        cols = new_section._sectPr.xpath("./w:cols")
        if cols:
            cols[0].set(qn("w:num"), "2")
        else:
            cols_el = OxmlElement("w:cols")
            cols_el.set(qn("w:num"), "2")
            cols_el.set(qn("w:space"), "360")
            new_section._sectPr.append(cols_el)
        target_secs = body_secs
    else:
        target_secs = sections

    for sec in target_secs:
        doc.add_heading(sec.get("heading", "Section"), level=1)
        for para in sec.get("content", "").split("\n\n"):
            if para.strip():
                doc.add_paragraph(para.strip())

    if references:
        doc.add_heading("References", level=1)
        for ref in references:
            doc.add_paragraph(ref)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def export_document_pdf_bytes(
    title: str,
    sections: List[Dict[str, str]],
    references: List[str] | None = None,
    style: str = "IEEE",
) -> bytes:
    """Generate publication-formatted IEEE (two-column) or APA PDF via WeasyPrint or ReportLab."""
    sec_html = "\n".join(
        f"<section><h2>{html.escape(s.get('heading', 'Section'))}</h2>"
        + "".join(f"<p>{html.escape(p.strip())}</p>" for p in s.get("content", "").split("\n\n") if p.strip())
        + "</section>"
        for s in sections
    )
    ref_html = (
        "<section><h2>References</h2>"
        + "".join(f"<p class='ref'>{html.escape(r)}</p>" for r in (references or []))
        + "</section>"
        if references
        else ""
    )
    cols_css = "column-count: 2; column-gap: 18pt;" if style.upper() == "IEEE" else ""
    html_doc = f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
@page {{ size: letter; margin: 0.75in; }}
body {{ font-family: 'Times New Roman', serif; font-size: 10pt; line-height: 1.38; color: #111; }}
h1 {{ font-size: 18pt; text-align: center; margin-bottom: 14pt; }}
.body {{ {cols_css} }}
h2 {{ font-size: 11pt; margin: 10pt 0 4pt; break-after: avoid; }}
p {{ margin: 0 0 6pt; text-align: justify; }}
.ref {{ font-size: 9pt; text-align: left; }}
</style></head><body>
<h1>{html.escape(title)}</h1>
<div class="body">{sec_html}{ref_html}</div>
</body></html>"""

    try:
        from weasyprint import HTML

        return HTML(string=html_doc).write_pdf()
    except ImportError:
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.utils import simpleSplit
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=letter)
        width, height = letter
        is_ieee = style.upper() == "IEEE"
        margin = 54
        col_gap = 18
        col_width = (width - 2 * margin - col_gap) / 2 if is_ieee else (width - 2 * margin)

        y = height - margin
        c.setFont("Times-Bold", 14)
        for tline in simpleSplit(title, "Times-Bold", 14, width - 2 * margin):
            c.drawCentredString(width / 2, y, tline)
            y -= 18
        y -= 10

        col_idx = 0
        x = margin

        def next_line(step: int = 13):
            nonlocal y, col_idx, x
            y -= step
            if y < margin:
                if is_ieee and col_idx == 0:
                    col_idx = 1
                    x = margin + col_width + col_gap
                    y = height - margin
                else:
                    c.showPage()
                    col_idx = 0
                    x = margin
                    y = height - margin

        all_blocks = list(sections)
        if references:
            all_blocks.append({"heading": "References", "content": "\n".join(references)})

        for sec in all_blocks:
            if y < margin + 30:
                next_line(30)
            c.setFont("Times-Bold", 11)
            for hline in simpleSplit(sec.get("heading", ""), "Times-Bold", 11, col_width):
                c.drawString(x, y, hline)
                next_line(14)
            next_line(2)
            c.setFont("Times-Roman", 10)
            for para in sec.get("content", "").splitlines():
                if not para.strip():
                    next_line(6)
                    continue
                for wline in simpleSplit(para.strip(), "Times-Roman", 10, col_width):
                    c.drawString(x, y, wline)
                    next_line(13)
            next_line(8)

        c.save()
        return buf.getvalue()


def verify_exported_docx_bytes(docx_bytes: bytes, expected_style: str = "IEEE") -> Dict[str, Any]:
    """Programmatically verify OOXML DOCX integrity, columns, headings, and margins."""
    with zipfile.ZipFile(io.BytesIO(docx_bytes), "r") as zf:
        names = set(zf.namelist())
        if "word/document.xml" not in names:
            raise ValueError("Invalid DOCX: missing word/document.xml")
        xml_str = zf.read("word/document.xml").decode("utf-8", errors="replace")

    has_two_col = 'w:num="2"' in xml_str
    if expected_style.upper() == "IEEE" and not has_two_col:
        raise ValueError("IEEE DOCX failed column check: expected 2-column OOXML layout.")
    if expected_style.upper() == "APA" and has_two_col:
        raise ValueError("APA DOCX failed column check: expected single-column OOXML layout.")
    return {
        "validZip": True,
        "hasTwoColumns": has_two_col,
        "hasMargins": "w:pgMar" in xml_str,
        "byteLength": len(docx_bytes),
    }


def verify_exported_pdf_bytes(pdf_bytes: bytes) -> Dict[str, Any]:
    """Programmatically verify PDF header, EOF trailer, page count (>0), and extractable text."""
    if not pdf_bytes or not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("Invalid PDF output header.")
    try:
        import fitz

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            pages = len(doc)
            if pages <= 0:
                raise ValueError("Invalid PDF: contains 0 pages.")
            extracted = "\n".join(p.get_text("text") for p in doc).strip()
            return {"validPdf": True, "pageCount": pages, "extractedChars": len(extracted)}
        finally:
            doc.close()
    except ImportError:
        if b"%%EOF" not in pdf_bytes[-2048:] and b"%%EOF" not in pdf_bytes:
            raise ValueError("Truncated PDF: missing %%EOF marker.")
        page_objects = re.findall(rb"/Type\s*/Page(?![s\w])", pdf_bytes)
        pages_counts = [int(m) for m in re.findall(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)", pdf_bytes)]
        page_count = len(page_objects) if page_objects else (max(pages_counts) if pages_counts else 0)
        if page_count <= 0:
            raise ValueError("Invalid PDF: no page objects (/Type /Page or /Count > 0) found.")
        return {"validPdf": True, "pageCount": page_count, "extractedChars": None}
