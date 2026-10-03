// Reads a bank statement exported from internet banking (CSV or Excel .xlsx)
// and returns the money that came IN: date, amount, reference and the
// description the bank shows (payer name, narration). Column names differ from
// bank to bank, so the header row is found by its words, not by position.
import ExcelJS from "exceljs";
import crypto from "node:crypto";
import { parsePaymentMessage } from "./parseMessage.js";

const HEADS = {
  date: /^(transaction\s*date|trans\.?\s*date|txn\s*date|value\s*date|posting\s*date|booking\s*date|date|tarehe)$/i,
  description: /(description|narration|details|particulars|remarks?|transaction\s*details|maelezo|naration)/i,
  credit: /^(credit|credits|cr|deposit|deposits|money\s*in|paid\s*in|credit\s*amount|amount\s*cr|amount\s*\(cr\)|kuingia)$/i,
  debit: /^(debit|debits|dr|withdrawal|withdrawals|money\s*out|paid\s*out|debit\s*amount|amount\s*dr|amount\s*\(dr\)|kutoka)$/i,
  amount: /^(amount|transaction\s*amount|amt|kiasi)$/i,
  type: /^(type|dr\/cr|cr\/dr|d\/c|transaction\s*type|direction)$/i,
  reference: /(reference|ref\.?\s*no|ref|transaction\s*id|txn\s*id|cheque|receipt\s*no|kumbukumbu)/i,
};

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (value.text) return String(value.text);
    if (value.result !== undefined) return cellText(value.result);
    if (value.richText) return value.richText.map((part) => part.text).join("");
  }
  return String(value).trim();
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || "";
  const delimiter = [",", ";", "\t", "|"].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field.trim()); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field.trim()); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell !== ""));
}

async function readRows(buffer, filename) {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) return parseCsv(buffer.toString("utf8").replace(/^﻿/, ""));
  if (name.endsWith(".xlsx")) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets.find((ws) => ws.rowCount > 1) || workbook.worksheets[0];
    const rows = [];
    sheet?.eachRow({ includeEmpty: false }, (row) => { rows.push(row.values.slice(1).map(cellText)); });
    return rows;
  }
  const error = new Error("Upload the statement as CSV or Excel (.xlsx). An old .xls file can be saved as .xlsx in Excel first.");
  error.status = 400;
  throw error;
}

function toNumber(value) {
  const text = String(value || "").replace(/[^\d.,()-]/g, "");
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const number = Number(text.replace(/[(),-]/g, "").replace(/(\..*)\./g, "$1"));
  return Number.isFinite(number) ? (negative ? -number : number) : 0;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function toDate(value) {
  const text = String(value || "").trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = text.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s,-]*(\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}

export async function parseStatement(buffer, filename) {
  const rows = await readRows(buffer, filename);
  // The header is the first row (within the first 30) that names a date and an amount/credit column.
  let headerIndex = -1;
  let map = null;
  for (let i = 0; i < Math.min(rows.length, 30) && headerIndex === -1; i += 1) {
    const found = {};
    rows[i].forEach((cell, index) => {
      const text = String(cell || "").trim();
      for (const [key, pattern] of Object.entries(HEADS)) if (found[key] === undefined && pattern.test(text)) found[key] = index;
    });
    if (found.date !== undefined && (found.credit !== undefined || found.amount !== undefined)) { headerIndex = i; map = found; }
  }
  if (headerIndex === -1) {
    const error = new Error("The statement's columns were not recognised. It needs a date column and a credit (money in) or amount column.");
    error.status = 400;
    throw error;
  }
  const credits = [];
  let skipped = 0;
  for (const cells of rows.slice(headerIndex + 1)) {
    const date = toDate(cells[map.date]);
    if (!date) { skipped += 1; continue; }
    let amount = 0;
    if (map.credit !== undefined) amount = toNumber(cells[map.credit]);
    else {
      amount = toNumber(cells[map.amount]);
      const type = String(cells[map.type] ?? "").toLowerCase();
      if (map.type !== undefined && /^(d|dr|debit)/.test(type)) amount = -Math.abs(amount);
      if (map.type !== undefined && /^(c|cr|credit)/.test(type)) amount = Math.abs(amount);
    }
    if (!(amount > 0)) { skipped += 1; continue; } // money out, fees, opening balance
    const description = map.description !== undefined ? String(cells[map.description] || "") : cells.join(" ");
    const read = parsePaymentMessage(`${description} TZS ${amount}`);
    let reference = map.reference !== undefined ? String(cells[map.reference] || "").trim().toUpperCase() : "";
    if (!reference) reference = read.reference || "";
    // No reference on the line: a stable one from the line itself, so uploading
    // the same statement twice never records the same money twice.
    if (!reference) reference = `BANK-${crypto.createHash("sha1").update(`${date}|${amount}|${description}`).digest("hex").slice(0, 10).toUpperCase()}`;
    // Who paid: what the description says once bank words, codes and numbers are removed.
    const payerName = read.payer_name || (description
      .replace(/\bMK-?C-?\d+\b/gi, " ")
      .replace(/\b(transfer|trf|tfr|from|to|cash|deposit|deposited|by|ft|ift|eft|rtgs|tiss|mobile|mpesa|m-pesa|airtel|mixx|tigo|payment|pay|for|ref|reference|credit|cr|inward|incoming|via|tz|tzs|tsh)\b/gi, " ")
      .replace(/[^A-Za-z .'&]/g, " ").replace(/\s+/g, " ").trim().toUpperCase() || null);
    credits.push({ line: credits.length + 1, paid_at: date, amount: Math.round(amount * 100) / 100, reference, description: description.slice(0, 300), payer_name: payerName, payer_phone: read.payer_phone || null, contract_number: read.contract_number || null });
  }
  return { credits, skipped, columns: Object.fromEntries(Object.entries(map).map(([key, index]) => [key, rows[headerIndex][index]])) };
}
