(function registerLetterPdf(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.LetterPdf = api;
  }
})(globalThis, function createLetterPdfApi() {
  const letterSections = new Set([
    "Employee Information",
    "Employment Details",
    "Company Information",
    "Closing Statement"
  ]);

  function getLetterLines(text) {
    return text.split(/\r?\n/).map((line, index) => {
      const content = line.trim();
      if (!content) return { type: "blank", text: "" };
      if (index === 0 && content === "EMPLOYMENT VERIFICATION LETTER") {
        return { type: "title", text: content };
      }
      if (/^(Reference Number|Generated):/.test(content)) {
        return { type: "metadata", text: content };
      }
      if (letterSections.has(content)) return { type: "section", text: content };
      return { type: "body", text: content };
    });
  }

  function escapePdfText(text) {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  function wrapPdfLines(text) {
    return getLetterLines(text).flatMap((line) => {
      if (line.type === "blank") return [line];

      const normalized = line.text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\x20-\x7E]/g, "?");
      const maxLength = line.type === "title" ? 60 : line.type === "section" ? 72 : 82;
      const words = normalized.split(/\s+/).filter(Boolean);
      const wrapped = [];
      let currentLine = "";

      words.forEach((word) => {
        if (currentLine && `${currentLine} ${word}`.length > maxLength) {
          wrapped.push({ type: line.type, text: currentLine });
          currentLine = word;
        } else {
          currentLine = currentLine ? `${currentLine} ${word}` : word;
        }
      });
      if (currentLine) wrapped.push({ type: line.type, text: currentLine });
      return wrapped;
    });
  }

  function createPdfDocument(text, qrMatrix) {
    const lines = wrapPdfLines(text);
    const lineHeights = { title: 36, metadata: 16, section: 22, body: 16, blank: 8 };
    const pages = [[]];
    let pageHeight = 0;
    lines.forEach((line) => {
      const height = lineHeights[line.type];
      if (pageHeight + height > (qrMatrix ? 600 : 680) && pages[pages.length - 1].length) {
        pages.push([]);
        pageHeight = 0;
      }
      pages[pages.length - 1].push(line);
      pageHeight += height;
    });

    const pageIds = Array.from({ length: pages.length }, (_, index) => 6 + index * 2);
    const objects = [
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      `2 0 obj << /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >> endobj`,
      "3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj",
      "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >> endobj"
    ];

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const pageId = pageIds[pageIndex];
      const contentId = pageId + 1;
      const commands = [];
      let y = 720;
      pages[pageIndex].forEach((line) => {
        if (line.type === "blank") {
          y -= lineHeights.blank;
          return;
        }

        if (line.type === "title") {
          y -= 22;
          const x = Math.max(72, (612 - line.text.length * 8.5) / 2);
          commands.push(`BT /F2 16 Tf ${x.toFixed(2)} ${y} Td (${escapePdfText(line.text)}) Tj ET`);
          y -= 14;
        } else if (line.type === "metadata") {
          y -= 14;
          const x = Math.max(72, (612 - line.text.length * 5.1) / 2);
          commands.push(`BT /F1 10 Tf ${x.toFixed(2)} ${y} Td (${escapePdfText(line.text)}) Tj ET`);
          y -= 2;
        } else if (line.type === "section") {
          y -= 10;
          commands.push(`BT /F2 12 Tf 72 ${y} Td (${escapePdfText(line.text)}) Tj ET`);
          y -= 12;
        } else if (/^Signature:/.test(line.text)) {
          y -= 18;
          commands.push(`BT /F3 15 Tf 90 ${y} Td (${escapePdfText(line.text)}) Tj ET`);
          y -= 3;
        } else {
          y -= 14;
          commands.push(`BT /F1 11 Tf 90 ${y} Td (${escapePdfText(line.text)}) Tj ET`);
          y -= 2;
        }
      });
      if (qrMatrix && Number.isInteger(qrMatrix.size) && qrMatrix.size > 0 && qrMatrix.data.length === qrMatrix.size * qrMatrix.size) {
        const qrWidth = 72;
        const moduleWidth = qrWidth / (qrMatrix.size + 8);
        const originX = 468;
        const originY = 72;
        commands.push(`1 g ${originX} ${originY} ${qrWidth} ${qrWidth} re f 0 g`);
        commands.push("0 g");
        for (let row = 0; row < qrMatrix.size; row += 1) {
          for (let column = 0; column < qrMatrix.size; column += 1) {
            if (!qrMatrix.data[row * qrMatrix.size + column]) continue;
            const x = originX + (column + 4) * moduleWidth;
            const y = originY + (qrMatrix.size - row + 3) * moduleWidth;
            commands.push(`${x.toFixed(2)} ${y.toFixed(2)} ${moduleWidth.toFixed(2)} ${moduleWidth.toFixed(2)} re f`);
          }
        }
        commands.push(`BT /F1 7 Tf 72 102 Td (Scan to verify: ${escapePdfText("US-EVS document reference")}) Tj ET`);
      }
      const stream = commands.join("\n");

      objects.push(
        `${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R >> endobj`,
        `${contentId} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`
      );
    }

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object) => {
      offsets.push(pdf.length);
      pdf += `${object}\n`;
    });

    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => {
      pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    });
    pdf += `trailer << /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return pdf;
  }

  function createPdfBlob(text, qrMatrix) {
    return new Blob([createPdfDocument(text, qrMatrix)], { type: "application/pdf" });
  }

  function createPdfBuffer(text, qrMatrix) {
    return Buffer.from(createPdfDocument(text, qrMatrix), "ascii");
  }

  return { getLetterLines, createPdfBlob, createPdfBuffer };
});