// Aggressive redaction for anything derived from an email. Conservative about what survives.
const R = "[redacted]";
const KEYWORD = "(?:code|otp|pin|passcode|verification|verify|password|token)";

const SENSITIVE_PARAM = /([?&](?:[\w.-]*(?:token|code|key|auth|secret|sig|password)[\w.-]*)=)[^&\s#]*/gi;
const KEYWORD_THEN_DIGITS = new RegExp(`(\\b${KEYWORD}\\b[^\\d\\n]{0,24}?)\\d{4,10}(?!\\d)`, "gi");
const DIGITS_THEN_KEYWORD = new RegExp(`(?<!\\d)\\d{4,10}(?=[^\\d\\n]{0,24}?\\b${KEYWORD}\\b)`, "gi");
const SECRET_PREFIX = /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{6,}|\bgh[pousr]_[A-Za-z0-9]{6,}|\bxox[abprs]-[A-Za-z0-9-]{6,}|\bAKIA[0-9A-Z]{12,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BLOB = /[A-Za-z0-9+/_=-]{20,}/g;
const LONG_DIGITS = /\d{5,}/g;

export function redact(text: string): string {
  try {
    if (!text) return "";
    let s = String(text);
    s = s.replace(SENSITIVE_PARAM, `$1${R}`);
    s = s.replace(BEARER, `Bearer ${R}`);
    s = s.replace(SECRET_PREFIX, R);
    s = s.replace(KEYWORD_THEN_DIGITS, `$1${R}`);
    s = s.replace(DIGITS_THEN_KEYWORD, R);
    s = s.replace(BLOB, R);
    s = s.replace(LONG_DIGITS, R);
    return s;
  } catch {
    return R;
  }
}
