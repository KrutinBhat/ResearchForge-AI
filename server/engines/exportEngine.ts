import JSZip from 'jszip';
import { jsPDF } from 'jspdf';
import { ParsedSection } from './documentParser';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function generateDocxBuffer(params: {
  title: string;
  sections: ParsedSection[];
  references: string[];
  style?: string;
}): Promise<Buffer> {
  const zip = new JSZip();
  const isIeee = (params.style || 'IEEE').toUpperCase() === 'IEEE';

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  const headerXml: string[] = [];
  const bodyXml: string[] = [];

  headerXml.push(`
    <w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:after="180"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${escapeXml(params.title)}</w:t></w:r>
    </w:p>`);

  if (params.style) {
    headerXml.push(`
      <w:p>
        <w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr>
        <w:r><w:rPr><w:i/><w:sz w:val="20"/><w:color w:val="475569"/></w:rPr><w:t>Formatted via ResearchForge AI (${escapeXml(params.style)} Template)</w:t></w:r>
      </w:p>`);
  }

  for (const sec of params.sections) {
    const isAbstractOrKw = isIeee && /^(abstract|keywords|index terms)$/i.test(sec.heading.trim());
    const targetArr = isAbstractOrKw ? headerXml : bodyXml;
    targetArr.push(`
      <w:p>
        <w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>
        <w:r><w:rPr><w:b/><w:sz w:val="${isIeee ? '22' : '24'}"/></w:rPr><w:t>${escapeXml(sec.heading)}</w:t></w:r>
      </w:p>`);
    for (const para of sec.content.split(/\n+/)) {
      if (!para.trim()) continue;
      targetArr.push(`
        <w:p>
          <w:pPr><w:spacing w:after="100" w:line="${isIeee ? '240' : '360'}" w:lineRule="auto"/></w:pPr>
          <w:r><w:rPr><w:sz w:val="${isIeee ? '20' : '22'}"/></w:rPr><w:t xml:space="preserve">${escapeXml(para.trim())}</w:t></w:r>
        </w:p>`);
    }
  }

  if (params.references.length > 0) {
    bodyXml.push(`
      <w:p>
        <w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>
        <w:r><w:rPr><w:b/><w:sz w:val="${isIeee ? '22' : '24'}"/></w:rPr><w:t>References</w:t></w:r>
      </w:p>`);
    for (const ref of params.references) {
      bodyXml.push(`
        <w:p>
          <w:pPr><w:spacing w:after="80"/></w:pPr>
          <w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(ref)}</w:t></w:r>
        </w:p>`);
    }
  }

  // Single-column continuous break before two-column IEEE body
  const sectionBreak = isIeee
    ? `<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:pPr></w:p>`
    : '';
  const bodySectPr = isIeee
    ? `<w:sectPr><w:type w:val="continuous"/><w:cols w:num="2" w:space="360"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>`
    : `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;

  zip.folder('word')?.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${headerXml.join('\n')}
    ${sectionBreak}
    ${bodyXml.join('\n')}
    ${bodySectPr}
  </w:body>
</w:document>`
  );

  return await zip.generateAsync({ type: 'nodebuffer' });
}

export function generatePdfBuffer(params: {
  title: string;
  sections: ParsedSection[];
  references: string[];
  subtitle?: string;
  style?: string;
}): Buffer {
  const isIeee = (params.style || 'IEEE').toUpperCase() === 'IEEE';
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = isIeee ? 46 : 56;
  const fullWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSingleSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  doc.setFont('times', 'bold');
  doc.setFontSize(16);
  const titleLines = doc.splitTextToSize(params.title, fullWidth);
  doc.text(titleLines, pageWidth / 2, y, { align: 'center' });
  y += titleLines.length * 19 + 4;

  if (params.subtitle) {
    doc.setFont('times', 'italic');
    doc.setFontSize(9.5);
    doc.setTextColor(71, 85, 105);
    doc.text(params.subtitle, pageWidth / 2, y, { align: 'center' });
    doc.setTextColor(15, 23, 42);
    y += 20;
  } else {
    y += 10;
  }

  // Render Abstract/Keywords full width when IEEE
  const bodySections: ParsedSection[] = [];
  for (const sec of params.sections) {
    if (isIeee && /^(abstract|keywords|index terms)$/i.test(sec.heading.trim())) {
      ensureSingleSpace(32);
      doc.setFont('times', 'bold');
      doc.setFontSize(10.5);
      doc.text(sec.heading, margin, y);
      y += 14;
      doc.setFont('times', 'normal');
      doc.setFontSize(9.5);
      const lines = doc.splitTextToSize(sec.content, fullWidth);
      for (const line of lines) {
        ensureSingleSpace(13);
        doc.text(line, margin, y);
        y += 12.5;
      }
      y += 8;
    } else {
      bodySections.push(sec);
    }
  }

  if (isIeee) {
    // Two-column layout for main body
    const colGap = 18;
    const colWidth = (fullWidth - colGap) / 2;
    let col = 0;
    const colTopStart = y + 6;
    let colY = colTopStart;

    const advanceColumn = (needed: number) => {
      if (colY + needed > pageHeight - margin) {
        if (col === 0) {
          col = 1;
          colY = colTopStart;
        } else {
          doc.addPage();
          col = 0;
          colY = margin;
        }
      }
    };
    const colX = () => margin + col * (colWidth + colGap);

    for (const sec of bodySections) {
      advanceColumn(28);
      doc.setFont('times', 'bold');
      doc.setFontSize(10.5);
      doc.text(doc.splitTextToSize(sec.heading, colWidth), colX(), colY);
      colY += 15;
      doc.setFont('times', 'normal');
      doc.setFontSize(9.5);
      for (const para of sec.content.split(/\n+/)) {
        if (!para.trim()) continue;
        const lines = doc.splitTextToSize(para.trim(), colWidth);
        for (const line of lines) {
          advanceColumn(13);
          doc.text(line, colX(), colY);
          colY += 12;
        }
        colY += 4;
      }
      colY += 4;
    }

    if (params.references.length > 0) {
      advanceColumn(26);
      doc.setFont('times', 'bold');
      doc.setFontSize(10.5);
      doc.text('References', colX(), colY);
      colY += 15;
      doc.setFont('times', 'normal');
      doc.setFontSize(8.5);
      for (const ref of params.references) {
        const lines = doc.splitTextToSize(ref, colWidth);
        for (const line of lines) {
          advanceColumn(12);
          doc.text(line, colX(), colY);
          colY += 11;
        }
        colY += 3;
      }
    }
  } else {
    for (const sec of bodySections) {
      ensureSingleSpace(36);
      doc.setFont('times', 'bold');
      doc.setFontSize(12);
      doc.text(sec.heading, margin, y);
      y += 18;
      doc.setFont('times', 'normal');
      doc.setFontSize(10.5);
      for (const para of sec.content.split(/\n+/)) {
        if (!para.trim()) continue;
        const lines = doc.splitTextToSize(para.trim(), fullWidth);
        for (const line of lines) {
          ensureSingleSpace(15);
          doc.text(line, margin, y);
          y += 14.5;
        }
        y += 6;
      }
      y += 6;
    }

    if (params.references.length > 0) {
      ensureSingleSpace(36);
      doc.setFont('times', 'bold');
      doc.setFontSize(12);
      doc.text('References', margin, y);
      y += 18;
      doc.setFont('times', 'normal');
      doc.setFontSize(9.5);
      for (const ref of params.references) {
        const lines = doc.splitTextToSize(ref, fullWidth);
        for (const line of lines) {
          ensureSingleSpace(14);
          doc.text(line, margin, y);
          y += 13;
        }
        y += 4;
      }
    }
  }

  return Buffer.from(doc.output('arraybuffer'));
}
