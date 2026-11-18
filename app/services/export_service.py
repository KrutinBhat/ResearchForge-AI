import html
import io
from typing import Dict, List


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

    doc = DocxDocument()
    title_p = doc.add_heading(title, level=0)
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    if style.upper() == "IEEE":
        # Title & Abstract stay single-column; switch subsequent section to 2-column IEEE layout
        abstract_secs = [s for s in sections if s.get("heading", "").lower() in {"abstract", "keywords"}]
        body_secs = [s for s in sections if s.get("heading", "").lower() not in {"abstract", "keywords"}]
        for sec in abstract_secs:
            doc.add_heading(sec.get("heading", ""), level=1)
            doc.add_paragraph(sec.get("content", ""))
        new_section = doc.add_section()
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
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=letter)
        width, height = letter
        y = height - 54
        c.setFont("Times-Bold", 14)
        c.drawCentredString(width / 2, y, title[:90])
        y -= 28
        c.setFont("Times-Roman", 10)
        for sec in sections:
            if y < 72:
                c.showPage()
                y = height - 54
            c.setFont("Times-Bold", 11)
            c.drawString(54, y, sec.get("heading", "")[:85])
            y -= 16
            c.setFont("Times-Roman", 10)
            for line in sec.get("content", "").splitlines():
                while line:
                    if y < 60:
                        c.showPage()
                        y = height - 54
                        c.setFont("Times-Roman", 10)
                    c.drawString(54, y, line[:92])
                    line = line[92:]
                    y -= 13
            y -= 8
        c.save()
        return buf.getvalue()
