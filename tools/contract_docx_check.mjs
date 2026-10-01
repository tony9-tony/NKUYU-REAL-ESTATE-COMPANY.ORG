// Offline check of contract document generation (no server, no database).
//
//   node tools/contract_docx_check.mjs
//
// 1. The built-in MKUYU letterhead: logo + title in the header and
//    "Page X of Y" in the footer, so every page carries the template.
// 2. A letterhead Word template: the chosen type's agreement is written where
//    the template says {{CONTRACT_BODY}}, and no placeholder is left behind.
// 3. A picture placed "Behind text" in the template body moves to the header,
//    so it repeats on every page of a longer contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { writeContractDocx } from "../backend/src/contracts/workflow.js";
import { fillWordTemplate } from "../backend/src/contracts/docxFill.js";
import { AGREEMENTS } from "../backend/src/contracts/agreements.js";
import { buildDocumentValues, renderContractDocument } from "../backend/src/contracts/generation.js";

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures += 1; };
const wellFormed = (xml) => {
  // Every opened element is closed in order (a cheap well-formedness check).
  const stack = [];
  for (const match of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (match[0].startsWith("<?")) continue;
    if (match[3] === "/") continue;
    if (match[1] === "/") { if (stack.pop() !== match[2]) return false; } else stack.push(match[2]);
  }
  return stack.length === 0;
};

const contract = { contract_number: "MK-C-000123", client_name: "Asha Juma", client_phone: "+255 700 000 000", client_email: "asha@example.com", original_price: 120000000, discount_pct: 5, discount_amount: 6000000, value: 114000000, deposit_amount: 14000000, installment_count: 10, payment_frequency: "monthly", first_due_date: "2026-11-01", start_date: "2026-10-01", end_date: "2027-10-01", agreement_duration: 12, agreement_duration_unit: "months", contract_date: "2026-10-01", title_deed_number: "CT-45821", deal_type: "rent" };
const property = { id: 7, name: "Villa 7", location: "Mbezi Beach, Dar es Salaam", property_type: "villa", area: 640 };
const project = { name: "Mbezi Gardens" };
const args = { contract, project, property, client: null, companyName: "MKUYU Real Estate", plan: {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mkuyu-docx-"));

// 1. Built-in letterhead.
for (const [type, agreement] of Object.entries(AGREEMENTS)) {
  const values = buildDocumentValues({ ...args, contract: { ...contract, deal_type: type } }, agreement.body);
  const text = renderContractDocument(agreement.body, values);
  check(!/\{\{\s*(?!LAWYER_SIGNATURE)[A-Z_]+\s*\}\}/.test(text), `${type}: every placeholder in the ${agreement.title} is filled`);
  check(text.includes("CT-45821") && text.includes("640 square metres"), `${type}: title deed and size are printed`);
  const target = path.join(tmp, `${type}.docx`);
  await writeContractDocx({ text, targetPath: target, title: agreement.title, contractNumber: contract.contract_number });
  const zip = await JSZip.loadAsync(fs.readFileSync(target));
  const headers = Object.keys(zip.files).filter((name) => /^word\/header\d*\.xml$/.test(name));
  const footers = Object.keys(zip.files).filter((name) => /^word\/footer\d*\.xml$/.test(name));
  const header = headers.length ? await zip.file(headers[0]).async("string") : "";
  const footer = footers.length ? await zip.file(footers[0]).async("string") : "";
  check(header.includes("<a:blip") && header.includes(agreement.title), `${type}: header carries the logo and "${agreement.title}"`);
  check(/PAGE/.test(footer) && /NUMPAGES/.test(footer), `${type}: footer shows Page X of Y`);
  const body = await zip.file("word/document.xml").async("string");
  check(body.includes(agreement.title.toUpperCase()) && body.includes("TITLE DEED") === false, `${type}: body holds the agreement title`);
  check(wellFormed(body) && wellFormed(header) && wellFormed(footer), `${type}: document XML is well formed`);
}

// 2 + 3. A letterhead template with a background picture behind the text.
const starter = path.join(tmp, "letterhead.docx");
await writeContractDocx({ text: "{{CONTRACT_BODY}}", targetPath: starter, title: "Agreement", contractNumber: "" });
const zip = await JSZip.loadAsync(fs.readFileSync(starter));
const png = fs.readFileSync(new URL("../frontend/assets/brand/mkuyu-logo-192.png", import.meta.url));
zip.file("word/media/background.png", png);
let rels = await zip.file("word/_rels/document.xml.rels").async("string");
rels = rels.replace("</Relationships>", '<Relationship Id="rIdBackground" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/background.png"/></Relationships>');
zip.file("word/_rels/document.xml.rels", rels);
let documentXml = await zip.file("word/document.xml").async("string");
const anchor = '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="7560000" cy="10692000"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="77" name="Page background"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="background.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdBackground"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="7560000" cy="10692000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
documentXml = documentXml.replace(/(<w:body>\s*<w:p(?=[\s>])[^>]*>)/, `$1${anchor}`);
zip.file("word/document.xml", documentXml);
const template = await zip.generateAsync({ type: "nodebuffer" });

const values = buildDocumentValues(args, AGREEMENTS.rent.body);
const filled = await JSZip.loadAsync(await fillWordTemplate(template, values));
const body = await filled.file("word/document.xml").async("string");
const bodyText = [...body.matchAll(/<w:t(?=[\s>])[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(" ");
check(!bodyText.includes("CONTRACT_BODY"), "letterhead: {{CONTRACT_BODY}} is replaced");
check(bodyText.includes("LEASE AGREEMENT") && bodyText.includes("Villa 7") && bodyText.includes("CT-45821"), "letterhead: the Lease Agreement is written on the template");
check(!/\{\{[^}]*\}\}/.test(bodyText), "letterhead: no placeholder is left in the document");
check((body.match(/<w:p(?=[\s>])/g) || []).length > 30, "letterhead: the agreement is real paragraphs (it can run onto more pages)");
check(!body.includes("rIdBackground"), "page design: the behind-text picture left the body");
const headerName = Object.keys(filled.files).find((name) => /^word\/header\d*\.xml$/.test(name));
const header = await filled.file(headerName).async("string");
const headerRels = await filled.file(`word/_rels/${headerName.replace("word/", "")}.rels`).async("string");
check(header.includes('r:embed="rIdBackground"') && header.includes('relativeFrom="page"'), "page design: the picture is in the header, anchored to the page");
check(headerRels.includes('Id="rIdBackground"'), "page design: the header can find the picture");
check(wellFormed(body) && wellFormed(header), "letterhead: XML is well formed");
fs.writeFileSync(path.join(tmp, "letterhead-filled.docx"), await filled.generateAsync({ type: "nodebuffer" }));

console.log(`\nFiles in ${tmp}`);
console.log(failures ? `${failures} check(s) failed` : "All contract document checks passed");
process.exit(failures ? 1 : 0);
