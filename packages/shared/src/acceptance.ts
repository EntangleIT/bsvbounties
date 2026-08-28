/** Sentinel pubkey so escrow `resolve` can be signed by the platform LLM arbiter. */
export const LLM_ARBITER_PUBKEY = 'llm-arbiter-v1'

/** Sentinel used when the platform verifier auto-approves. */
export const VERIFIER_PUBKEY = 'ai-bounties-verifier-v1'

export type AcceptanceKind =
  | 'manual'
  | 'http'
  | 'schema'
  | 'command'
  | 'llm-judge'

export interface ManualAcceptance {
  kind: 'manual'
}

export interface HttpAcceptance {
  kind: 'http'
  method?: 'GET' | 'POST'
  /** If omitted, the worker's `workUri` is fetched. */
  url?: string
  expectStatus?: number
  jsonPath?: string
  expect?: string | number | boolean
  regex?: string
  body?: unknown
  headers?: Record<string, string>
}

export interface SchemaAcceptance {
  kind: 'schema'
  schema: Record<string, unknown>
}

export interface CommandAcceptance {
  kind: 'command'
  /** If omitted, compared to the submitted workHash. */
  expectedHash?: string
}

export interface LlmJudgeAcceptance {
  kind: 'llm-judge'
  rubric?: string
  /** 0–1 inclusive; default 0.7 */
  passScore?: number
}

export type AcceptanceSpec =
  | ManualAcceptance
  | HttpAcceptance
  | SchemaAcceptance
  | CommandAcceptance
  | LlmJudgeAcceptance

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
    kind === 'llm-judge' ||
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
