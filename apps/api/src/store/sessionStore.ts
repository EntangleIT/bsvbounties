import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

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

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export class SessionStore {
  private filePath: string
  private sessions: Session[] = []
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'sessions.json')
  }

  async init(): Promise<void> {
    if (this.loaded) return
    await mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreFile
      this.sessions = (parsed.sessions ?? []).filter(
        (s) => new Date(s.expiresAt).getTime() > Date.now(),
      )
    } catch {
      this.sessions = []
      await this.persist()
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.filePath,
      JSON.stringify({ sessions: this.sessions }, null, 2),
      'utf8',
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
    // Drop other sessions for same controller+account
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
    if (new Date(s.expiresAt).getTime() <= Date.now()) {
      void this.revoke(token)
      return undefined
    }
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

/** In-memory challenges (short-lived). */
export class ChallengeStore {
  private map = new Map<string, { challenge: string; expires: number }>()

  issue(controllerKey: string): { challenge: string; expiresAt: string } {
    const challenge = randomBytes(24).toString('hex')
    const expires = Date.now() + 5 * 60 * 1000
    this.map.set(controllerKey, { challenge, expires })
    // prune occasionally
    if (this.map.size > 500) {
      for (const [k, v] of this.map) {
        if (v.expires < Date.now()) this.map.delete(k)
      }
    }
    return { challenge, expiresAt: new Date(expires).toISOString() }
  }

  consume(controllerKey: string, challenge: string): boolean {
    const row = this.map.get(controllerKey)
    if (!row) return false
    if (row.expires < Date.now()) {
      this.map.delete(controllerKey)
      return false
    }
    if (row.challenge !== challenge) return false
    this.map.delete(controllerKey)
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
