/**
 * Secret redaction (phase 10 hardening). Any env var whose NAME matches the
 * hint pattern or the explicit blocklist has its VALUE replaced with `***`
 * wherever it appears in outbound text (tool output, terminal echoes, SSE).
 */

const SECRET_KEY_HINT = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|CERT|SIGNATURE)/i;

/** Vars whose names don't match the hint but are secrets anyway. */
const SECRET_NAME_BLOCKLIST = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "NPM_CONFIG__AUTHTOKEN",
  "AWS_SESSION",
  "OPENAI_ORG"
]);

const MIN_SECRET_LENGTH = 6;

export type Redactor = (text: string) => string;

/** Builds a redactor over the given environment (default process.env). */
export function createSecretRedactor(env: NodeJS.ProcessEnv = process.env): Redactor {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_KEY_HINT.test(key) || SECRET_NAME_BLOCKLIST.has(key.toUpperCase())) {
      secrets.push(value);
    }
  }
  // longest first so partial overlaps redact fully
  secrets.sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join("***");
    }
    return out;
  };
}
