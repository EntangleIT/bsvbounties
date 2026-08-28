import { sha256Hex } from './hash.js'
import {
  assertHttpUrl,
  getJsonPath,
  normalizeWorkFetchUrl,
  validateJsonSchema,
  type AcceptanceSpec,
  type LlmJudgeAcceptance,
  type Verification,
} from './acceptance.js'

export interface LlmJudgeInput {
  spec: LlmJudgeAcceptance
  workUri?: string
  workBody?: string
  notes?: string
  requirements: string[]
  title: string
  description: string
  disputeReason?: string
}

export interface LlmJudgeResult {
  pass: boolean
  score: number
  reason: string
  fraud?: boolean
}

export interface VerifyDeps {
  fetch?: typeof fetch
  llmJudge?: (input: LlmJudgeInput) => Promise<LlmJudgeResult>
  now?: () => Date
}

export interface VerifyWorkInput {
  acceptance: AcceptanceSpec
  workUri?: string
  workHash?: string
  notes?: string
  requirements?: string[]
  title?: string
  description?: string
}

const MAX_BODY = 1_000_000

export async function verifyWork(
  input: VerifyWorkInput,
  deps: VerifyDeps = {},
): Promise<Verification> {
  const nowFn = deps.now ?? (() => new Date())
  const now = nowFn().toISOString()
  const kind = input.acceptance.kind
  try {
    switch (input.acceptance.kind) {
      case 'manual':
        return {
          passed: false,
          kind,
          reason: 'manual_approval_required',
          checkedAt: now,
        }
      case 'http':
        return await verifyHttp(input.acceptance, input, deps, now)
      case 'schema':
        return await verifySchema(input.acceptance.schema, input, deps, now)
      case 'command':
        return await verifyCommand(input, deps, now)
      case 'llm-judge':
        return await verifyLlm(input.acceptance, input, deps, now)
      default:
        return {
          passed: false,
          kind: 'manual',
          reason: 'unknown_acceptance_kind',
          checkedAt: now,
        }
    }
  } catch (e) {
    return {
      passed: false,
      kind,
      reason: e instanceof Error ? e.message : String(e),
      checkedAt: now,
    }
  }
}

async function readUrl(
  url: string,
  deps: VerifyDeps,
  init?: RequestInit,
): Promise<{ status: number; text: string; json?: unknown; contentType: string; bytes: number }> {
  const ok = assertHttpUrl(url)
  if (!ok.ok) throw new Error(ok.error)
  const fetchFn = deps.fetch ?? globalThis.fetch
  if (!fetchFn) throw new Error('fetch_unavailable')
  const target = normalizeWorkFetchUrl(url)
  const headers = new Headers(init?.headers)
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'ai-bounties-verifier/1')
  }
  const res = await fetchFn(target, {
    ...init,
    headers,
    redirect: 'follow',
    signal: init?.signal ?? AbortSignal.timeout(8000),
  })
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > MAX_BODY) throw new Error('body_too_large')
  const contentType = res.headers.get('content-type') ?? ''
  const text = new TextDecoder().decode(buf)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: res.status, text, json, contentType, bytes: buf.byteLength }
}

async function verifyHttp(
  spec: Extract<AcceptanceSpec, { kind: 'http' }>,
  input: VerifyWorkInput,
  deps: VerifyDeps,
  now: string,
): Promise<Verification> {
  const target = spec.url || input.workUri
  if (!target) {
    return { passed: false, kind: 'http', reason: 'missing_url', checkedAt: now }
  }
  const method = spec.method ?? 'GET'
  const headers: Record<string, string> = { ...(spec.headers ?? {}) }
  let body: string | undefined
  if (method === 'POST' && spec.body !== undefined) {
    body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body)
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json'
    }
  }
  const fetched = await readUrl(target, deps, { method, headers, body })
  const expectStatus = spec.expectStatus ?? 200
  if (fetched.status !== expectStatus) {
    return {
      passed: false,
      kind: 'http',
      reason: `status_${fetched.status}_expected_${expectStatus}`,
      checkedAt: now,
      details: { status: fetched.status, contentType: fetched.contentType },
    }
  }
  if (spec.contentTypePrefix) {
    const ct = fetched.contentType.toLowerCase()
    const want = spec.contentTypePrefix.toLowerCase()
    if (!ct.startsWith(want)) {
      return {
        passed: false,
        kind: 'http',
        reason: 'content_type_mismatch',
        checkedAt: now,
        details: { contentType: fetched.contentType, expect: spec.contentTypePrefix },
      }
    }
  }
  if (spec.regex) {
    let re: RegExp
    try {
      re = new RegExp(spec.regex)
    } catch {
      return { passed: false, kind: 'http', reason: 'bad_regex', checkedAt: now }
    }
    if (!re.test(fetched.text)) {
      return {
        passed: false,
        kind: 'http',
        reason: 'regex_mismatch',
        checkedAt: now,
      }
    }
  }
  if (spec.jsonPath) {
    if (fetched.json === undefined) {
      return {
        passed: false,
        kind: 'http',
        reason: 'response_not_json',
        checkedAt: now,
        details: { contentType: fetched.contentType },
      }
    }
    const got = getJsonPath(fetched.json, spec.jsonPath)
    if (spec.expect !== undefined) {
      if (got !== spec.expect) {
        return {
          passed: false,
          kind: 'http',
          reason: `jsonPath_${spec.jsonPath}_mismatch`,
          checkedAt: now,
          details: { got, expect: spec.expect },
        }
      }
    } else if (got === undefined) {
      return {
        passed: false,
        kind: 'http',
        reason: `jsonPath_${spec.jsonPath}_missing`,
        checkedAt: now,
      }
    }
  }
  return {
    passed: true,
    kind: 'http',
    reason: 'http_check_passed',
    checkedAt: now,
    details: { status: fetched.status, url: target, contentType: fetched.contentType },
  }
}

async function verifySchema(
  schema: Record<string, unknown>,
  input: VerifyWorkInput,
  deps: VerifyDeps,
  now: string,
): Promise<Verification> {
  if (!input.workUri) {
    return { passed: false, kind: 'schema', reason: 'missing_work_uri', checkedAt: now }
  }
  const fetched = await readUrl(input.workUri, deps)
  if (fetched.json === undefined) {
    return {
      passed: false,
      kind: 'schema',
      reason: 'response_not_json',
      checkedAt: now,
      details: { contentType: fetched.contentType },
    }
  }
  const result = validateJsonSchema(schema, fetched.json)
  if (!result.ok) {
    return {
      passed: false,
      kind: 'schema',
      reason: result.error,
      checkedAt: now,
    }
  }
  return {
    passed: true,
    kind: 'schema',
    reason: 'schema_valid',
    checkedAt: now,
  }
}

async function verifyCommand(
  input: VerifyWorkInput,
  deps: VerifyDeps,
  now: string,
): Promise<Verification> {
  const spec = input.acceptance as Extract<AcceptanceSpec, { kind: 'command' }>
  if (!input.workUri) {
    return { passed: false, kind: 'command', reason: 'missing_work_uri', checkedAt: now }
  }
  const fetched = await readUrl(input.workUri, deps)
  const digest = sha256Hex(fetched.text)
  const expected = spec.expectedHash || input.workHash
  if (!expected) {
    return {
      passed: false,
      kind: 'command',
      reason: 'missing_expected_hash',
      checkedAt: now,
    }
  }
  if (digest !== expected.replace(/^0x/, '').toLowerCase()) {
    return {
      passed: false,
      kind: 'command',
      reason: 'hash_mismatch',
      checkedAt: now,
      details: { digest },
    }
  }
  return {
    passed: true,
    kind: 'command',
    reason: 'artifact_hash_matched',
    checkedAt: now,
    details: { digest },
  }
}

async function verifyLlm(
  spec: LlmJudgeAcceptance,
  input: VerifyWorkInput,
  deps: VerifyDeps,
  now: string,
): Promise<Verification> {
  if (!deps.llmJudge) {
    return {
      passed: false,
      kind: 'llm-judge',
      reason: 'llm_unavailable',
      checkedAt: now,
    }
  }
  let workBody = input.notes ?? ''
  if (input.workUri) {
    try {
      const fetched = await readUrl(input.workUri, deps)
      if (/^image\//i.test(fetched.contentType)) {
        workBody = `[image ${fetched.contentType} ${fetched.bytes} bytes at ${normalizeWorkFetchUrl(input.workUri)}]`
      } else {
        workBody = fetched.text.slice(0, 20_000)
      }
    } catch {
      workBody = `${workBody}\n[fetch failed for ${input.workUri}]`
    }
  }
  const judged = await deps.llmJudge({
    spec,
    workUri: input.workUri,
    workBody,
    notes: input.notes,
    requirements: input.requirements ?? [],
    title: input.title ?? '',
    description: input.description ?? '',
  })
  const threshold = spec.passScore ?? 0.7
  const passed = judged.pass && judged.score >= threshold
  return {
    passed,
    kind: 'llm-judge',
    reason: judged.reason,
    fraud: judged.fraud,
    score: judged.score,
    checkedAt: now,
  }
}
