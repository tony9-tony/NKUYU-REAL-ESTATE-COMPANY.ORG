// MKUYU branded file exporters: Excel (.xlsx), PDF, Word (.docx), PowerPoint (.pptx).
// Every exporter receives the same payload shape produced by buildReport().
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, TextRun } from "docx";
import PptxGenJS from "pptxgenjs";

export const BRAND = "MKUYU";
export const BRAND_SUB = "Real Estate Management System";
export const BRAND_GREEN = "0B6B4D";
export const BRAND_GOLD = "B8945B";

export const EXPORT_FORMATS = {
  xlsx: { extension: ".xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel (.xlsx)" },
  pdf: { extension: ".pdf", mime: "application/pdf", label: "PDF (.pdf)" },
  docx: { extension: ".docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word (.docx)" },
  pptx: { extension: ".pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint (.pptx)" },
};

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function displayValue(value, kind) {
  if (value === null || value === undefined || value === "") return "";
  if (kind === "money" || kind === "int") return formatNumber(value);
  if (kind === "date") {
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const timePart = raw.slice(11, 16);
      const [year, month, day] = raw.slice(0, 10).split("-").map(Number);
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const pretty = `${String(day).padStart(2, "0")} ${months[month - 1]} ${year}`;
      return /^\d{2}:\d{2}$/.test(timePart) ? `${pretty} ${timePart}` : pretty;
    }
    return raw;
  }
  return String(value);
}

function generatedLabel(payload) {
  return new Date(payload.generated_at).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fileNameFor(payload, extension) {
  const slug = `${payload.title}-${payload.type}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${slug}-${payload.generated_at.slice(0, 10)}${extension}`;
}

function excelWorksheetName(value) {
  const normalized = String(value || "Report")
    .replace(/[\\/*?[\]:]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .trim();
  return (normalized || "Report").slice(0, 31);
}

function cellValue(raw, kind) {
  if (kind === "money" || kind === "int") {
    const number = Number(raw);
    return Number.isFinite(number) ? number : 0;
  }
  return displayValue(raw, kind);
}

function payloadValue(row, column) {
  return cellValue(row?.[column.key], column.kind);
}

// ---------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------
async function exportXlsx(payload) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = `${BRAND} · ${BRAND_SUB}`;
  workbook.lastModifiedBy = BRAND;
  workbook.created = new Date(payload.generated_at);
  workbook.modified = new Date(payload.generated_at);
  const sheet = workbook.addWorksheet(excelWorksheetName(payload.title), {
    views: [{ state: "frozen", ySplit: 6 }],
    pageSetup: { orientation: "landscape", fitToPage: true },
  });
  const columnCount = Math.max(payload.columns.length, 1);

  sheet.mergeCells(1, 1, 1, columnCount);
  const brandCell = sheet.getCell(1, 1);
  brandCell.value = `${BRAND} · ${BRAND_SUB}`;
  brandCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  brandCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BRAND_GREEN}` } };
  brandCell.alignment = { vertical: "middle" };
  sheet.getRow(1).height = 28;

  sheet.mergeCells(2, 1, 2, columnCount);
  const titleCell = sheet.getCell(2, 1);
  titleCell.value = payload.title;
  titleCell.font = { name: "Calibri", size: 13, bold: true, color: { argb: `FF${BRAND_GREEN}` } };

  ["Filters: " + payload.filters_text,
    `Generated: ${generatedLabel(payload)} · Rows: ${payload.row_count}`].forEach((line, index) => {
    const rowNumber = 3 + index;
    sheet.mergeCells(rowNumber, 1, rowNumber, columnCount);
    const cell = sheet.getCell(rowNumber, 1);
    cell.value = line;
    cell.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF405B51" } };
  });

  const writeDataRow = (excelRow, columns, row) => {
    columns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      cell.value = payloadValue(row, column);
      if (column.kind === "money") cell.numFmt = "#,##0.00";
      if (column.kind === "int") cell.numFmt = "#,##0";
      cell.alignment = { vertical: "middle", horizontal: column.kind === "text" ? "left" : "right" };
    });
  };
  const writeHeader = (excelRow, columns, color) => {
    columns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      cell.value = column.label;
      cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
      cell.alignment = { vertical: "middle", horizontal: column.kind === "text" ? "left" : "right" };
    });
  };

  const headerRow = sheet.getRow(6);
  writeHeader(headerRow, payload.columns, BRAND_GREEN);
  headerRow.height = 20;

  let rowNumber = 7;
  for (const row of payload.rows) {
    writeDataRow(sheet.getRow(rowNumber), payload.columns, row);
    rowNumber += 1;
  }

  if (payload.totals?.length) {
    rowNumber += 1;
    const totalRow = sheet.getRow(rowNumber);
    payload.totals.forEach((total, index) => {
      const cell = totalRow.getCell(index + 1);
      const value = total.kind === "money" || total.kind === "int" ? formatNumber(total.value) : String(total.value ?? "");
      cell.value = `${total.label}: ${value}`;
      cell.font = { bold: true, color: { argb: `FF${BRAND_GREEN}` } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF4EF" } };
    });
  }

  for (const section of payload.sections || []) {
    rowNumber += 2;
    sheet.mergeCells(rowNumber, 1, rowNumber, columnCount);
    const sectionCell = sheet.getCell(rowNumber, 1);
    sectionCell.value = section.title;
    sectionCell.font = { bold: true, size: 12, color: { argb: `FF${BRAND_GOLD}` } };
    rowNumber += 1;
    writeHeader(sheet.getRow(rowNumber), section.columns, "15956F");
    rowNumber += 1;
    for (const row of section.rows) {
      writeDataRow(sheet.getRow(rowNumber), section.columns, row);
      rowNumber += 1;
    }
  }

  payload.columns.forEach((column, index) => {
    let longest = column.label.length;
    for (const row of payload.rows.slice(0, 200)) {
      longest = Math.max(longest, displayValue(row[column.key], column.kind).length);
    }
    sheet.getColumn(index + 1).width = Math.min(Math.max(longest + 4, 12), 46);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer: Buffer.from(buffer), extension: ".xlsx", mime: EXPORT_FORMATS.xlsx.mime, fileName: fileNameFor(payload, ".xlsx") };
}

// ---------------------------------------------------------------------------
// PDF (.pdf)
// ---------------------------------------------------------------------------
function exportPdf(payload) {
  return new Promise((resolve, reject) => {
    const landscape = payload.columns.length > 6;
    const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 36, bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve({
      buffer: Buffer.concat(chunks),
      extension: ".pdf",
      mime: EXPORT_FORMATS.pdf.mime,
      fileName: fileNameFor(payload, ".pdf"),
    }));
    doc.on("error", reject);

    const pageLeft = doc.page.margins.left;
    const pageRight = doc.page.width - doc.page.margins.right;
    const usableWidth = pageRight - pageLeft;
    const addHeader = () => {
      doc.save();
      doc.rect(0, 0, doc.page.width, 58).fill(BRAND_GREEN);
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(16).text(BRAND, pageLeft, 18);
      doc.font("Helvetica").fontSize(9).fillColor("#D8BF8D").text(BRAND_SUB, pageLeft + 72, 22);
      doc.fontSize(9).fillColor("#FFFFFF").text("CONFIDENTIAL · MKUYU", pageRight - 130, 22, { width: 130, align: "right" });
      doc.restore();
      doc.y = 78;
      doc.fillColor(BRAND_GREEN).font("Helvetica-Bold").fontSize(20).text(payload.title, { width: usableWidth });
      doc.moveDown(0.25);
      doc.fillColor("#405B51").font("Helvetica").fontSize(8).text(`Filters: ${payload.filters_text}`, { width: usableWidth });
      doc.text(`Generated: ${generatedLabel(payload)} · Rows: ${payload.row_count}`, { width: usableWidth });
      doc.moveDown(0.7);
    };

    const drawTable = (columns, rows) => {
      const width = usableWidth / Math.max(columns.length, 1);
      const drawHeader = () => {
        const y = doc.y;
        doc.save();
        doc.rect(pageLeft, y, usableWidth, 20).fill(BRAND_GREEN);
        doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7.5);
        columns.forEach((column, index) => doc.text(column.label, pageLeft + index * width + 4, y + 6, { width: width - 8, lineBreak: false, ellipsis: true }));
        doc.restore();
        doc.y = y + 20;
      };
      drawHeader();
      rows.forEach((row, rowIndex) => {
        if (doc.y + 22 > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          addHeader();
          drawHeader();
        }
        const y = doc.y;
        doc.save();
        doc.fillColor(rowIndex % 2 === 0 ? "#FFFFFF" : "#F3F8F5").rect(pageLeft, y, usableWidth, 22).fill();
        doc.strokeColor("#D9E7E0").lineWidth(0.5).rect(pageLeft, y, usableWidth, 22).stroke();
        doc.fillColor("#12352B").font("Helvetica").fontSize(7.5);
        columns.forEach((column, index) => {
          const value = displayValue(row[column.key], column.kind);
          doc.text(value, pageLeft + index * width + 4, y + 7, {
            width: width - 8,
            lineBreak: false,
            ellipsis: true,
            align: column.kind === "money" || column.kind === "int" ? "right" : "left",
          });
        });
        doc.restore();
        doc.y = y + 22;
      });
      doc.moveDown(0.8);
    };

    const drawTotals = (totals) => {
      if (!totals?.length) return;
      if (doc.y + 20 > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        addHeader();
      }
      const text = totals.map((total) => `${total.label}: ${total.kind === "money" || total.kind === "int" ? formatNumber(total.value) : total.value}`).join("   ·   ");
      doc.save();
      doc.fillColor("#EAF4EF").roundedRect(pageLeft, doc.y, usableWidth, 24, 4).fill();
      doc.fillColor(BRAND_GREEN).font("Helvetica-Bold").fontSize(8).text(text, pageLeft + 8, doc.y + 8, { width: usableWidth - 16 });
      doc.restore();
      doc.y += 34;
    };

    addHeader();
    drawTable(payload.columns, payload.rows);
    drawTotals(payload.totals);
    for (const section of payload.sections || []) {
      if (doc.y + 50 > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        addHeader();
      }
      doc.fillColor(BRAND_GOLD).font("Helvetica-Bold").fontSize(11).text(section.title);
      doc.moveDown(0.3);
      drawTable(section.columns, section.rows);
    }
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      doc.fillColor("#71877D").font("Helvetica").fontSize(7).text(
        `${BRAND} · ${BRAND_SUB}   |   Page ${index + 1} of ${range.count}`,
        pageLeft,
        doc.page.height - 25,
        { width: usableWidth, align: "center" },
      );
    }
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------
function docxCell(value, kind, header = false) {
  return new TableCell({
    shading: { fill: header ? BRAND_GREEN : "F3F8F5" },
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: kind === "money" || kind === "int" ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: String(value ?? ""), bold: header, color: header ? "FFFFFF" : "12352B", size: header ? 18 : 16 })],
    })],
  });
}

function docxTable(columns, rows) {
  const header = new TableRow({ children: columns.map((column) => docxCell(column.label, column.kind, true)) });
  const body = rows.map((row) => new TableRow({
    children: columns.map((column) => docxCell(displayValue(row[column.key], column.kind), column.kind)),
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: "D9E7E0" },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: "D9E7E0" },
      left: { style: BorderStyle.SINGLE, size: 2, color: "D9E7E0" },
      right: { style: BorderStyle.SINGLE, size: 2, color: "D9E7E0" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "E5EEE9" },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "E5EEE9" },
    },
    rows: [header, ...body],
  });
}

async function exportDocx(payload) {
  const children = [
    new Paragraph({ children: [new TextRun({ text: `${BRAND} · ${BRAND_SUB}`, bold: true, color: BRAND_GREEN, size: 30 })] }),
    new Paragraph({ children: [new TextRun({ text: payload.title, bold: true, color: BRAND_GOLD, size: 26 })] }),
    new Paragraph({ children: [new TextRun({ text: `Filters: ${payload.filters_text}`, italics: true, color: "405B51", size: 17 })] }),
    new Paragraph({ children: [new TextRun({ text: `Generated: ${generatedLabel(payload)} · Rows: ${payload.row_count}`, italics: true, color: "405B51", size: 17 })] }),
    docxTable(payload.columns, payload.rows),
  ];
  if (payload.totals?.length) {
    children.push(new Paragraph({ children: [new TextRun({ text: payload.totals.map((total) => `${total.label}: ${total.kind === "money" || total.kind === "int" ? formatNumber(total.value) : total.value}`).join("   ·   "), bold: true, color: BRAND_GREEN, size: 18 })] }));
  }
  for (const section of payload.sections || []) {
    children.push(new Paragraph({ children: [new TextRun({ text: section.title, bold: true, color: BRAND_GOLD, size: 22 })] }));
    children.push(docxTable(section.columns, section.rows));
  }
  const document = new Document({
    creator: `${BRAND} · ${BRAND_SUB}`,
    title: payload.title,
    description: payload.description,
    sections: [{ properties: {}, children }],
  });
  const buffer = await Packer.toBuffer(document);
  return { buffer: Buffer.from(buffer), extension: ".docx", mime: EXPORT_FORMATS.docx.mime, fileName: fileNameFor(payload, ".docx") };
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx)
// ---------------------------------------------------------------------------
async function exportPptx(payload) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = `${BRAND} · ${BRAND_SUB}`;
  pptx.company = BRAND;
  pptx.subject = payload.description;
  pptx.title = payload.title;
  pptx.lang = "en-GB";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "en-GB",
  };

  const addHeader = (slide, title) => {
    slide.background = { color: "F3F8F5" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.62, fill: { color: BRAND_GREEN }, line: { color: BRAND_GREEN } });
    slide.addText(BRAND, { x: 0.45, y: 0.13, w: 1.2, h: 0.25, fontFace: "Aptos Display", fontSize: 18, bold: true, color: "FFFFFF" });
    slide.addText(BRAND_SUB, { x: 1.55, y: 0.16, w: 3.2, h: 0.2, fontSize: 9, color: "D8BF8D" });
    slide.addText(title, { x: 0.55, y: 0.86, w: 12.1, h: 0.45, fontFace: "Aptos Display", fontSize: 24, bold: true, color: BRAND_GREEN });
    slide.addText(`Filters: ${payload.filters_text}`, { x: 0.58, y: 1.32, w: 12, h: 0.2, fontSize: 9, color: "405B51" });
    slide.addText(`Generated: ${generatedLabel(payload)} · Rows: ${payload.row_count}`, { x: 0.58, y: 1.53, w: 12, h: 0.2, fontSize: 9, color: "405B51" });
  };

  const addTableSlides = (columns, rows, title) => {
    const maxRows = 13;
    const chunks = [];
    for (let index = 0; index < Math.max(rows.length, 1); index += maxRows) chunks.push(rows.slice(index, index + maxRows));
    chunks.forEach((chunk, chunkIndex) => {
      const slide = pptx.addSlide();
      addHeader(slide, `${title}${chunks.length > 1 ? ` · ${chunkIndex + 1}/${chunks.length}` : ""}`);
      const tableRows = [
        columns.map((column) => ({ text: column.label, options: { bold: true, color: "FFFFFF", fill: BRAND_GREEN } })),
        ...chunk.map((row) => columns.map((column) => ({ text: displayValue(row[column.key], column.kind), options: { color: "12352B", fill: "F8FBF9" } }))),
      ];
      slide.addTable(tableRows, {
        x: 0.5, y: 1.95, w: 12.3, h: 4.75,
        border: { type: "solid", color: "D9E7E0", pt: 0.6 },
        fontFace: "Aptos", fontSize: 8, color: "12352B", margin: 0.04,
        autoFit: false, valign: "mid", rowH: 0.28,
      });
    });
  };

  addTableSlides(payload.columns, payload.rows, payload.title);
  for (const section of payload.sections || []) addTableSlides(section.columns, section.rows, section.title);
  if (payload.totals?.length) {
    const slide = pptx.addSlide();
    addHeader(slide, `${payload.title} · Totals`);
    slide.addText(payload.totals.map((total) => `${total.label}: ${total.kind === "money" || total.kind === "int" ? formatNumber(total.value) : total.value}`).join("\n"), {
      x: 1, y: 2.2, w: 11, h: 2.8, fontFace: "Aptos", fontSize: 18, bold: true, color: BRAND_GREEN,
      breakLine: true, paraSpaceAfterPt: 14, valign: "mid",
    });
  }
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return { buffer: Buffer.from(buffer), extension: ".pptx", mime: EXPORT_FORMATS.pptx.mime, fileName: fileNameFor(payload, ".pptx") };
}

export async function exportReport(payload, format) {
  const normalized = String(format || "xlsx").toLowerCase();
  if (normalized === "xlsx") return exportXlsx(payload);
  if (normalized === "pdf") return exportPdf(payload);
  if (normalized === "docx") return exportDocx(payload);
  if (normalized === "pptx") return exportPptx(payload);
  throw new Error("Unsupported report export format");
}

export { exportXlsx, exportPdf, exportDocx, exportPptx };