const API_BASE = (process.env.AI_BOUNTIES_API_URL ?? 'http://localhost:8787').replace(
  /\/$/,
  '',
)

export async function api<T>(
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (init?.token) headers.Authorization = `Bearer ${init.token}`

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  if (!res.ok) {
    const err = body as { error?: string; note?: string; message?: string }
    throw new Error(
      err.error ?? err.note ?? err.message ?? `HTTP ${res.status}`,
    )
  }
  return body as T
}

export function apiBase(): string {
  return API_BASE
}
