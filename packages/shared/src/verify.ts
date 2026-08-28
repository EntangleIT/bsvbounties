import { sha256Hex } from './hash.js'
import {
  assertHttpUrl,
  getJsonPath,
  googleDriveFileId,
  looksLikeHtml,
  normalizeWorkFetchUrl,
  validateJsonSchema,
  type AcceptanceSpec,
  type HashAcceptance,
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
      case 'hash':
        return await verifyHash(input.acceptance, input, deps, now)
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
): Promise<{
  status: number
  text: string
  body: Uint8Array
  json?: unknown
  contentType: string
  bytes: number
  finalUrl: string
}> {
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
  return {
    status: res.status,
    text,
    body: buf,
    json,
    contentType,
    bytes: buf.byteLength,
    finalUrl: target,
  }
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

  // Drive share/view pages are HTML viewers — refuse when asking for JSON.
  const wantsJson = Boolean(spec.jsonPath) || (!spec.contentTypePrefix && !spec.regex)
  if (wantsJson && googleDriveFileId(target) && !spec.contentTypePrefix) {
    return {
      passed: false,
      kind: 'http',
      reason: 'http_not_for_drive',
      checkedAt: now,
      details: {
        hint: 'Use acceptance.kind "hash" or "llm-judge" for Drive/file artifacts.',
        url: target,
      },
    }
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
  } else if (
    !spec.contentTypePrefix &&
    !spec.regex &&
    looksLikeHtml(fetched.contentType, fetched.text)
  ) {
    // Bare http kind against an HTML page — fail closed with a clear hint.
    return {
      passed: false,
      kind: 'http',
      reason: 'response_not_json',
      checkedAt: now,
      details: { contentType: fetched.contentType },
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

async function verifyHash(
  spec: HashAcceptance | Extract<AcceptanceSpec, { kind: 'command' }>,
  input: VerifyWorkInput,
  deps: VerifyDeps,
  now: string,
): Promise<Verification> {
  const kind = spec.kind
  if (!input.workUri) {
    return { passed: false, kind, reason: 'missing_work_uri', checkedAt: now }
  }
  const fetched = await readUrl(input.workUri, deps)
  if (looksLikeHtml(fetched.contentType, fetched.text)) {
    return {
      passed: false,
      kind,
      reason: 'html_not_artifact',
      checkedAt: now,
      details: {
        contentType: fetched.contentType,
        url: fetched.finalUrl,
        hint: 'Rejecting HTML viewer/error pages. Use a direct file URL or export link.',
      },
    }
  }
  const digest = sha256Hex(fetched.body)
  const expected = (spec.expectedHash || input.workHash)?.replace(/^0x/, '').toLowerCase()
  if (!expected) {
    return {
      passed: false,
      kind,
      reason: 'missing_expected_hash',
      checkedAt: now,
    }
  }
  if (digest !== expected) {
    return {
      passed: false,
      kind,
      reason: 'hash_mismatch',
      checkedAt: now,
      details: { digest, bytes: fetched.bytes, contentType: fetched.contentType },
    }
  }
  return {
    passed: true,
    kind,
    reason: 'artifact_hash_matched',
    checkedAt: now,
    details: { digest, bytes: fetched.bytes, contentType: fetched.contentType },
  }
}

function llmServiceFailureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/402|429|credit|quota|billing|insufficient|exhausted/i.test(msg)) {
    return 'llm_credits_exhausted'
  }
  if (/503|unavailable|timeout|ECONN|fetch failed/i.test(msg)) {
    return 'llm_unavailable'
  }
  // Treat provider HTTP errors as soft (do not mark work cryptographically failed).
  if (/LLM \w+ error \d{3}/i.test(msg)) {
    return /402|429/.test(msg) ? 'llm_credits_exhausted' : 'llm_unavailable'
  }
  return 'llm_unavailable'
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
      } else if (looksLikeHtml(fetched.contentType, fetched.text)) {
        workBody = `[html page ${fetched.bytes} bytes — likely a viewer, not the artifact]\n${fetched.text.slice(0, 2000)}`
      } else {
        workBody = fetched.text.slice(0, 20_000)
      }
    } catch {
      workBody = `${workBody}\n[fetch failed for ${input.workUri}]`
    }
  }
  const rubric = spec.rubric ?? spec.prompt
  try {
    const judged = await deps.llmJudge({
      spec: { ...spec, rubric },
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
  } catch (e) {
    return {
      passed: false,
      kind: 'llm-judge',
      reason: llmServiceFailureReason(e),
      checkedAt: now,
      details: {
        softFailure: true,
        error: e instanceof Error ? e.message : String(e),
      },
    }
  }
}
