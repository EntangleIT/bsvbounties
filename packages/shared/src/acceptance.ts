/** Sentinel pubkey so escrow `resolve` can be signed by the platform LLM arbiter. */
export const LLM_ARBITER_PUBKEY = 'llm-arbiter-v1'

/** Sentinel used when the platform verifier auto-approves. */
export const VERIFIER_PUBKEY = 'ai-bounties-verifier-v1'

export type AcceptanceKind =
  | 'manual'
  | 'http'
  | 'schema'
  | 'command'
  | 'hash'
  | 'llm-judge'
  | 'sealed'

export interface ManualAcceptance {
  kind: 'manual'
}

/**
 * HTTP check for JSON APIs (or Content-Type prefix checks).
 * Not for Google Drive share pages / raw PNG without contentTypePrefix —
 * use `hash` or `llm-judge` for file artifacts.
 */
export interface HttpAcceptance {
  kind: 'http'
  method?: 'GET' | 'POST'
  /** If omitted, the worker's `workUri` is fetched. */
  url?: string
  expectStatus?: number
  jsonPath?: string
  expect?: string | number | boolean
  regex?: string
  /** Response Content-Type must start with this, e.g. `image/` or `application/json`. */
  contentTypePrefix?: string
  body?: unknown
  headers?: Record<string, string>
}

export interface SchemaAcceptance {
  kind: 'schema'
  schema: Record<string, unknown>
}

/** @deprecated Prefer `hash`. Same behavior: SHA-256 of workUri body vs workHash. */
export interface CommandAcceptance {
  kind: 'command'
  /** If omitted, compared to the submitted workHash. */
  expectedHash?: string
}

/** Fetch workUri (follow redirects), SHA-256 body bytes, compare to workHash. */
export interface HashAcceptance {
  kind: 'hash'
  /** If omitted, compared to the submitted workHash. */
  expectedHash?: string
}

export interface LlmJudgeAcceptance {
  kind: 'llm-judge'
  /** Rubric / scoring criteria (also accepted as `prompt`). */
  rubric?: string
  /** Alias for `rubric`. */
  prompt?: string
  /** 0–1 inclusive; default 0.7 */
  passScore?: number
}

/**
 * Sealed submission (Trust B): the worker attaches a hash-chained custody
 * envelope proving existence + provenance. The artifact itself is never
 * fetched, so private/encrypted/offline work can still be proven.
 * Pair with `hash`/`llm-judge` milestones for content inspection.
 */
export interface SealedAcceptance {
  kind: 'sealed'
  /** If omitted, compared to the submitted workHash. */
  expectedHash?: string
  /**
   * When true, a bound RFC 3161 token is required. The platform requests
   * one at verify time if the envelope lacks it (`stampedBy: platform`).
   */
  requireTimestamp?: boolean
}

export type AcceptanceSpec =
  | ManualAcceptance
  | HttpAcceptance
  | SchemaAcceptance
  | CommandAcceptance
  | HashAcceptance
  | LlmJudgeAcceptance
  | SealedAcceptance

/** Reasons that are service/waiting states — not cryptographic verify failures. */
export const SOFT_VERIFY_REASONS = new Set([
  'manual_approval_required',
  'llm_unavailable',
  'llm_credits_exhausted',
  'timestamp_unavailable',
])

export function isSoftVerification(v: Pick<Verification, 'passed' | 'reason'>): boolean {
  return !v.passed && SOFT_VERIFY_REASONS.has(v.reason)
}

export interface Verification {
  passed: boolean
  kind: AcceptanceKind
  reason: string
  fraud?: boolean
  score?: number
  checkedAt: string
  details?: Record<string, unknown>
}

export type MilestoneStatus = 'pending' | 'submitted' | 'paid' | 'failed'

export interface MilestoneInput {
  title?: string
  amountSats: number
  acceptance: AcceptanceSpec
}

export interface Milestone extends MilestoneInput {
  status: MilestoneStatus
  workHash?: string
  workUri?: string
  verification?: Verification
}

export type ArbiterMode = 'none' | 'llm' | 'pubkey'

export function defaultAcceptance(): ManualAcceptance {
  return { kind: 'manual' }
}

export function isAutoRelease(spec: AcceptanceSpec | undefined): boolean {
  return Boolean(spec && spec.kind !== 'manual')
}

export function parseAcceptance(raw: unknown): AcceptanceSpec {
  if (!raw || typeof raw !== 'object') return defaultAcceptance()
  const kind = (raw as { kind?: string }).kind
  if (
    kind === 'http' ||
    kind === 'schema' ||
    kind === 'command' ||
    kind === 'hash' ||
    kind === 'llm-judge' ||
    kind === 'sealed' ||
    kind === 'manual'
  ) {
    return raw as AcceptanceSpec
  }
  return defaultAcceptance()
}

export function validateMilestones(
  amountSats: number,
  milestones?: MilestoneInput[],
): string | null {
  if (!milestones?.length) return null
  if (milestones.some((m) => !Number.isInteger(m.amountSats) || m.amountSats <= 0)) {
    return 'invalid_milestone_amount'
  }
  const sum = milestones.reduce((a, m) => a + m.amountSats, 0)
  if (sum !== amountSats) return 'milestones_sum_mismatch'
  return null
}

export function initMilestones(inputs: MilestoneInput[]): Milestone[] {
  return inputs.map((m) => ({
    title: m.title,
    amountSats: m.amountSats,
    acceptance: m.acceptance,
    status: 'pending',
  }))
}

export function getJsonPath(obj: unknown, path: string): unknown {
  if (!path) return obj
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * Minimal JSON Schema subset: type, properties, required, const, enum,
 * pattern, items, minimum, maximum.
 */
export function validateJsonSchema(
  schema: unknown,
  data: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!schema || typeof schema !== 'object') {
    return { ok: false, error: 'invalid_schema' }
  }
  return check(schema as Record<string, unknown>, data, '$')
}

function check(
  schema: Record<string, unknown>,
  data: unknown,
  path: string,
): { ok: true } | { ok: false; error: string } {
  if (schema.const !== undefined) {
    if (data !== schema.const) {
      return { ok: false, error: `${path}: expected const ${JSON.stringify(schema.const)}` }
    }
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      return { ok: false, error: `${path}: not in enum` }
    }
  }
  const t = schema.type
  if (t === 'object') {
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: `${path}: expected object` }
    }
    const obj = data as Record<string, unknown>
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (typeof key === 'string' && !(key in obj)) {
        return { ok: false, error: `${path}: missing ${key}` }
      }
    }
    const props = schema.properties
    if (props && typeof props === 'object') {
      for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
        if (key in obj && sub && typeof sub === 'object') {
          const r = check(sub as Record<string, unknown>, obj[key], `${path}.${key}`)
          if (!r.ok) return r
        }
      }
    }
  } else if (t === 'array') {
    if (!Array.isArray(data)) return { ok: false, error: `${path}: expected array` }
    if (schema.items && typeof schema.items === 'object') {
      for (let i = 0; i < data.length; i++) {
        const r = check(schema.items as Record<string, unknown>, data[i], `${path}[${i}]`)
        if (!r.ok) return r
      }
    }
  } else if (t === 'string') {
    if (typeof data !== 'string') return { ok: false, error: `${path}: expected string` }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(data)) {
          return { ok: false, error: `${path}: pattern mismatch` }
        }
      } catch {
        return { ok: false, error: `${path}: bad pattern` }
      }
    }
  } else if (t === 'number' || t === 'integer') {
    if (typeof data !== 'number' || (t === 'integer' && !Number.isInteger(data))) {
      return { ok: false, error: `${path}: expected ${t}` }
    }
    if (typeof schema.minimum === 'number' && data < schema.minimum) {
      return { ok: false, error: `${path}: below minimum` }
    }
    if (typeof schema.maximum === 'number' && data > schema.maximum) {
      return { ok: false, error: `${path}: above maximum` }
    }
  } else if (t === 'boolean') {
    if (typeof data !== 'boolean') return { ok: false, error: `${path}: expected boolean` }
  } else if (t === 'null') {
    if (data !== null) return { ok: false, error: `${path}: expected null` }
  }
  return { ok: true }
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  if (s.length % 2) return s[mid]!
  return Math.floor((s[mid - 1]! + s[mid]!) / 2)
}

export function assertHttpUrl(url: string): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'invalid_url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'unsupported_url_scheme' }
  }
  return { ok: true, url: parsed }
}

/** File id from a Google Drive share/view/open URL, if any. */
export function googleDriveFileId(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const host = parsed.hostname.replace(/^www\./, '')
  if (host !== 'drive.google.com' && host !== 'docs.google.com') return undefined
  const idParam = parsed.searchParams.get('id')
  if (idParam) return idParam
  const fileMatch = parsed.pathname.match(/\/(?:file|document|presentation|spreadsheets)\/d\/([^/]+)/)
  return fileMatch?.[1]
}

/**
 * Drive *view* links return an HTML viewer, not the file. Rewrite to the
 * direct-download endpoint so image/content-type checks can see the bytes.
 */
export function normalizeWorkFetchUrl(url: string): string {
  const id = googleDriveFileId(url)
  if (!id) return url
  try {
    const parsed = new URL(url)
    if (parsed.pathname.includes('/uc') && parsed.searchParams.get('export') === 'download') {
      return url
    }
  } catch {
    return url
  }
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`
}

export function looksLikeHtml(contentType: string, bodyText: string): boolean {
  const ct = contentType.toLowerCase()
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return true
  const head = bodyText.trimStart().slice(0, 256).toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

export function formatVerificationReason(
  v: Pick<Verification, 'passed' | 'reason' | 'kind' | 'details'>,
): string {
  if (v.passed) {
    if (v.reason === 'http_check_passed') return 'HTTP check passed'
    if (v.reason === 'schema_valid') return 'JSON schema valid'
    if (v.reason === 'artifact_hash_matched') return 'Artifact hash matched'
    return v.reason.replace(/_/g, ' ')
  }
  switch (v.reason) {
    case 'response_not_json':
      return (
        'Work URL did not return JSON. HTTP acceptance is for JSON APIs, not Drive/PNG files. ' +
        'Use acceptance.kind "hash" (sha256 of file bytes) or "llm-judge" for artifacts, or submit a JSON API URL.'
      )
    case 'http_not_for_drive':
      return (
        'HTTP acceptance cannot verify Google Drive share/view links as JSON. ' +
        'Use acceptance.kind "hash" or "llm-judge", or a direct JSON API URL.'
      )
    case 'html_not_artifact':
      return (
        'Fetched work URL returned an HTML page (viewer/error), not the file bytes. ' +
        'Use a direct download/export URL, or acceptance.kind "llm-judge" / manual for non-hashable hosts.'
      )
    case 'content_type_mismatch': {
      const got = v.details?.contentType
      return `Work URL Content-Type was ${got ? String(got) : 'missing'}, not the type this bounty requires.`
    }
    case 'manual_approval_required':
      return 'Waiting for the poster to approve.'
    case 'llm_unavailable':
      return 'LLM judge is unavailable; work stays submitted — resubmit later or ask the poster to approve.'
    case 'llm_credits_exhausted':
      return 'LLM credits exhausted; work was not marked failed. Resubmit later or use poster approve.'
    case 'missing_url':
      return 'No work URL to fetch.'
    case 'regex_mismatch':
      return 'Response body did not match the required pattern.'
    case 'hash_mismatch':
      return 'SHA-256 of fetched workUri did not match submitted workHash.'
    case 'seal_missing':
      return 'Sealed bounty needs a custody envelope. Submit with a seal from createSubmitSeal({ workHash, submitter }).'
    case 'seal_hash_mismatch':
    case 'seal_event_hash_mismatch':
    case 'seal_stamp_hash_mismatch':
      return 'Seal envelope does not bind the submitted work hash. Re-seal the exact bytes you delivered.'
    case 'seal_broken_link':
    case 'seal_bad_token':
    case 'seal_bad_version':
    case 'seal_bad_work_hash':
    case 'seal_bad_genesis':
    case 'seal_empty_chain':
      return 'Seal envelope failed structural verification (tamper-evident chain broken). Re-seal and resubmit.'
    case 'seal_actor_mismatch':
      return 'Seal submitter does not match your logged-in account. Seal with your own key.'
    case 'timestamp_unavailable':
      return 'Trusted timestamping is temporarily unreachable; work stays submitted — resubmit later or ask the poster to approve.'
    default:
      return v.reason.replace(/_/g, ' ')
  }
}
