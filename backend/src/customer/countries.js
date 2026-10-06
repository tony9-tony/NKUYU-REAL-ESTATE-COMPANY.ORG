// Countries for the diaspora sign-up: the list a customer chooses from, and the
// country a phone number belongs to (from its international dialling code).
// The phone is a hint, never proof: many Tanzanians abroad keep a +255 line,
// so a mismatch only flags the customer for the desk to check.

export const COUNTRIES = [
  ["TZ", "Tanzania", "255"], ["AE", "United Arab Emirates", "971"], ["OM", "Oman", "968"], ["QA", "Qatar", "974"],
  ["SA", "Saudi Arabia", "966"], ["KW", "Kuwait", "965"], ["BH", "Bahrain", "973"], ["GB", "United Kingdom", "44"],
  ["IE", "Ireland", "353"], ["DE", "Germany", "49"], ["NL", "Netherlands", "31"], ["BE", "Belgium", "32"], ["FR", "France", "33"],
  ["IT", "Italy", "39"], ["ES", "Spain", "34"], ["SE", "Sweden", "46"], ["NO", "Norway", "47"], ["DK", "Denmark", "45"],
  ["FI", "Finland", "358"], ["CH", "Switzerland", "41"], ["AT", "Austria", "43"], ["PL", "Poland", "48"], ["TR", "Turkey", "90"],
  ["US", "United States", "1"], ["CA", "Canada", "1"], ["AU", "Australia", "61"], ["NZ", "New Zealand", "64"],
  ["CN", "China", "86"], ["IN", "India", "91"], ["MY", "Malaysia", "60"], ["JP", "Japan", "81"], ["KR", "South Korea", "82"],
  ["KE", "Kenya", "254"], ["UG", "Uganda", "256"], ["RW", "Rwanda", "250"], ["BI", "Burundi", "257"], ["CD", "DR Congo", "243"],
  ["ZM", "Zambia", "260"], ["MW", "Malawi", "265"], ["MZ", "Mozambique", "258"], ["ZA", "South Africa", "27"], ["BW", "Botswana", "267"],
  ["ZW", "Zimbabwe", "263"], ["NA", "Namibia", "264"], ["ET", "Ethiopia", "251"], ["SS", "South Sudan", "211"], ["SD", "Sudan", "249"],
  ["EG", "Egypt", "20"], ["NG", "Nigeria", "234"], ["GH", "Ghana", "233"], ["CM", "Cameroon", "237"], ["MA", "Morocco", "212"],
  ["SC", "Seychelles", "248"], ["MU", "Mauritius", "230"], ["KM", "Comoros", "269"], ["IL", "Israel", "972"], ["LB", "Lebanon", "961"],
  ["JO", "Jordan", "962"], ["IQ", "Iraq", "964"], ["PK", "Pakistan", "92"], ["BR", "Brazil", "55"],
];
const BY_CODE = new Map(COUNTRIES.map(([code, name, dial]) => [code, { code, name, dial }]));
// Longest dialling code first, so +971 is not read as +97x or +9.
const BY_DIAL = [...COUNTRIES].sort((a, b) => b[2].length - a[2].length);

export const countryByCode = (code) => BY_CODE.get(String(code || "").toUpperCase()) || null;

/** E.164-style digits for a number typed as +971 50…, 00971 50…, or 07… (Tanzania). */
export function internationalDigits(value) {
  const raw = String(value || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (raw.startsWith("00")) digits = digits.slice(2);
  else if (!raw.startsWith("+") && digits.startsWith("0") && digits.length === 10) digits = `255${digits.slice(1)}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** The country a phone number dials into, or null. +1 is reported as US/Canada. */
export function countryFromPhone(value) {
  const digits = internationalDigits(value);
  if (!digits) return null;
  const hit = BY_DIAL.find(([, , dial]) => digits.startsWith(dial));
  if (!hit) return null;
  if (hit[2] === "1") return { code: "US", name: "United States / Canada", dial: "1", digits };
  return { code: hit[0], name: hit[1], dial: hit[2], digits };
}

/** Does the phone agree with the declared country of residence? */
export function phoneMatchesResidence(phoneCountry, residenceCode) {
  if (!phoneCountry || !residenceCode) return false;
  if (phoneCountry.dial === "1") return ["US", "CA"].includes(residenceCode);
  return phoneCountry.code === residenceCode;
}
