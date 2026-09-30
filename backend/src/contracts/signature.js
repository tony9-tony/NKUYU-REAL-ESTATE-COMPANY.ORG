// ---------------------------------------------------------------------------
// Lawyer's signature on the generated contract.
//
// A member of Legal (anyone holding `approve_legal`) uploads a signature image
// once, from their profile. When they give Legal approval to a contract, the
// contract's Word document is regenerated with their signature block appended
// ("Signed for and on behalf of ... (Legal)", image, name, title, date), and
// the contract records who signed and when. If the approver has not uploaded
// a signature yet, approval still works - the document simply stays unsigned.
//
// The signature image is never shown to anyone else through the API; it only
// ever leaves the server embedded in a contract document.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { query, queryOne } from "../db.js";
import { documentUploadsDir, profileUploadsDir, removeStoredFile, resolveStoredFile } from "../uploads.js";
import { generateContractDocument, formatDocumentDate } from "./workflow.js";

/** The signature block for a contract, or null when it has none. */
export async function contractSignature(contract) {
  if (!contract?.legal_signed_by) return null;
  const signer = await queryOne("SELECT display_name, signature_stored_name, signature_title FROM users WHERE id=$1", [contract.legal_signed_by]);
  const file = resolveStoredFile(profileUploadsDir, signer?.signature_stored_name);
  if (!file) return null;
  const organization = await queryOne("SELECT name FROM organizations WHERE id=$1", [contract.organization_id]);
  return {
    image: fs.readFileSync(file),
    name: signer.display_name,
    title: signer.signature_title || "Legal",
    company: organization?.name || "MKUYU",
    date: formatDocumentDate(new Date(contract.legal_signed_at || Date.now()).toISOString().slice(0, 10)),
  };
}

/**
 * Applies `userId`'s signature to the contract's generated document. Returns
 * true when the document was signed, false when there was nothing to sign
 * with (no signature uploaded, or no generated document).
 */
export async function signContractDocument(contractId, userId) {
  const user = await queryOne("SELECT signature_stored_name FROM users WHERE id=$1", [userId]);
  if (!resolveStoredFile(profileUploadsDir, user?.signature_stored_name)) return false;
  const contract = await queryOne(
    "UPDATE contracts SET legal_signed_by=$1, legal_signed_at=NOW() WHERE id=$2 RETURNING *",
    [userId, contractId],
  );
  if (!contract?.generated_document_id) return false;
  const document = await queryOne("SELECT * FROM documents WHERE id=$1 AND category='agreement'", [contract.generated_document_id]);
  if (!document?.body_text) return false;
  const signature = await contractSignature(contract);
  const file = await generateContractDocument({ text: document.body_text, title: document.title || "Sale Agreement", contractNumber: contract.contract_number, signature });
  await query(
    "UPDATE documents SET original_filename=$1, stored_name=$2, file_size=$3, mime_type=$4, uploaded_at=NOW() WHERE id=$5",
    [file.original_filename, file.stored_name, file.file_size, file.mime_type, document.id],
  );
  if (document.stored_name && document.stored_name !== file.stored_name) removeStoredFile(documentUploadsDir, document.stored_name);
  return true;
}
