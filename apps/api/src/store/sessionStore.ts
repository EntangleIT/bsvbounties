import { createHash, randomBytes } from 'node:crypto'
import { persistFrom, type JsonPersist } from './persist.js'

export interface Session {
  token: string
  controllerKey: string
  accountNumber: number
  createdAt: string
  expiresAt: string
}

interface StoreFile {
  sessions: Session[]
}

interface ChallengeFile {
  items: Record<string, { challenge: string; expires: number }>
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export class SessionStore {
  private backend: JsonPersist
  private sessions: Session[] = []

  constructor(dataDirOrPersist: string | JsonPersist) {
    this.backend = persistFrom(dataDirOrPersist, 'sessions.json')
  }

  async init(): Promise<void> {
    const raw = await this.backend.read()
    if (!raw) {
      this.sessions = []
      return
    }
    try {
      const parsed = JSON.parse(raw) as StoreFile
      this.sessions = (parsed.sessions ?? []).filter(
        (s) => new Date(s.expiresAt).getTime() > Date.now(),
      )
    } catch {
      this.sessions = []
    }
  }

  private async persist(): Promise<void> {
    await this.backend.write(
      JSON.stringify({ sessions: this.sessions }, null, 2),
    )
  }

  async create(controllerKey: string, accountNumber: number): Promise<Session> {
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    const session: Session = {
      token,
      controllerKey,
      accountNumber,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    }
    this.sessions = this.sessions.filter(
      (s) =>
        !(
          s.controllerKey === controllerKey &&
          s.accountNumber === accountNumber
        ),
    )
    this.sessions.push(session)
    await this.persist()
    return session
  }

  get(token: string): Session | undefined {
    const s = this.sessions.find((x) => x.token === token)
    if (!s) return undefined
    if (new Date(s.expiresAt).getTime() <= Date.now()) return undefined
    return s
  }

  async revoke(token: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.token !== token)
    await this.persist()
  }

  /** Invalidate every session for an account (e.g. after sale/transfer). */
  async revokeAccount(accountNumber: number): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.accountNumber !== accountNumber)
    await this.persist()
  }

  /** Drop sessions that no longer match the controller (ownership change). */
  async revokeControllerOnAccount(
    accountNumber: number,
    controllerKey: string,
  ): Promise<void> {
    this.sessions = this.sessions.filter(
      (s) =>
        !(s.accountNumber === accountNumber && s.controllerKey === controllerKey),
    )
    await this.persist()
  }
}

/** Short-lived login challenges. Optional persist so Cloudflare isolates share them. */
export class ChallengeStore {
  private backend?: JsonPersist
  private map = new Map<string, { challenge: string; expires: number }>()

  constructor(persist?: JsonPersist) {
    this.backend = persist
  }

  async init(): Promise<void> {
    if (!this.backend) return
    const raw = await this.backend.read()
    this.map.clear()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as ChallengeFile
      const now = Date.now()
      for (const [key, row] of Object.entries(parsed.items ?? {})) {
        if (row.expires > now) this.map.set(key, row)
      }
    } catch {
      /* empty */
    }
  }

  private async persist(): Promise<void> {
    if (!this.backend) return
    const items = Object.fromEntries(this.map)
    await this.backend.write(JSON.stringify({ items }))
  }

  async issue(
    controllerKey: string,
  ): Promise<{ challenge: string; expiresAt: string }> {
    const challenge = randomBytes(24).toString('hex')
    const expires = Date.now() + 5 * 60 * 1000
    this.map.set(controllerKey, { challenge, expires })
    if (this.map.size > 500) {
      const now = Date.now()
      for (const [k, v] of this.map) {
        if (v.expires < now) this.map.delete(k)
      }
    }
    await this.persist()
    return { challenge, expiresAt: new Date(expires).toISOString() }
  }

  async consume(controllerKey: string, challenge: string): Promise<boolean> {
    const row = this.map.get(controllerKey)
    if (!row) return false
    if (row.expires < Date.now()) {
      this.map.delete(controllerKey)
      await this.persist()
      return false
    }
    if (row.challenge !== challenge) return false
    this.map.delete(controllerKey)
    await this.persist()
    return true
  }
}

/**
 * Demo signature: sha256 hex of auth message + controller key.
 * Real wallets should ECDSA-sign the auth message; API will accept demo form
 * when AUTH_MODE=demo (default).
 */
export function demoSignature(message: string, controllerKey: string): string {
  return createHash('sha256')
    .update(`${message}:${controllerKey}`)
    .digest('hex')
}

export function verifyDemoSignature(
  message: string,
  controllerKey: string,
  signature: string,
): boolean {
  return demoSignature(message, controllerKey) === signature
}
