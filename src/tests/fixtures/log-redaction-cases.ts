/**
 * Synthetic fixtures transcribed from infra PR #4842 round-3 evidence:
 * cold_pem.go, spec/pem_boundaries.go and harness/round3_cases.go.
 * Source: _deliverables/infra-pr-4842-review/rereview-round3/evidence.tar.gz
 * No production keys or prompt bodies are included.
 */
export const PEM_TAIL = "QUJDREVGR0hJSktMTU5PUA==";
export const PEM_BODY = "A".repeat(64);
export const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n${PEM_TAIL}\n-----END PRIVATE KEY-----`;
export const PEM_SEGMENTS = [
  `[Bootstrap] init\n-----BEGIN PRIVATE KEY-----\n${PEM_BODY}`,
  `${PEM_TAIL}\n-----END PRIVATE KEY-----`,
];

export const PROMPT_SENTINEL = "private prompt sentinel that must never appear in logs";
// Prompt/output cases from extra_cases.go in the same evidence archive.
export const PROMPT_CASES = [
  "line one\n\nPARA_TWO_SECRET\n  indented SECRET2\n}",
  "short preview\nLINE_TWO_SECRET...",
  "out1\nOUTPUT_SECRET\n",
  "...TRUNCATED...tail of a huge prompt TAIL_SECRET\nmore TAIL_SECRET",
  "a\n\nb SLACK_SECRET\n}",
];

export const CREDENTIAL_CASES = [
  ...["xoxb", "xoxa", "xoxp", "xoxr", "xoxs", "xoxe", "xoxo", "xoxc", "xoxd"].map((prefix) => ({
    name: `Slack ${prefix}`,
    secret: `${prefix}-${"1234567890-".repeat(3)}`,
    wrap: (secret: string) => `token ${secret}`,
  })),
  ...[
    "sk-",
    "sk-ant-",
    "sk-proj-",
    "sk-or-v1-",
    "sk-svcacct-",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
  ].map((prefix) => ({
    name: prefix,
    secret: `${prefix}${"Q".repeat(36)}`,
    wrap: (secret: string) => `token ${secret}`,
  })),
  { name: "bearer", secret: "short-bearer", wrap: (s: string) => `Authorization: Bearer ${s}` },
  {
    name: "JWT",
    secret: `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`,
    wrap: (s: string) => `token ${s}`,
  },
  {
    name: "connection string",
    secret: "db-password",
    wrap: (s: string) => `postgres://alice:${s}@localhost/database`,
  },
  {
    name: "connection string without username",
    secret: "db-password",
    wrap: (s: string) => `redis://:${s}@localhost/0`,
  },
  ...["API_KEY", "password", "client_secret", "access_token"].map((key) => ({
    name: `assignment ${key}`,
    secret: "v!3",
    wrap: (s: string) => `[worker] ${key}=${s}`,
  })),
];
