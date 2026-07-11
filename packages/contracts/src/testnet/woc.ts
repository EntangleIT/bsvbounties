import { wocApiBase } from './config.js'

export interface WocUtxo {
  height: number
  tx_pos: number
  tx_hash: string
  value: number
}

export async function getAddressUtxos(address: string): Promise<WocUtxo[]> {
  const res = await fetch(`${wocApiBase()}/address/${address}/unspent`)
  if (!res.ok) throw new Error(`WoC utxos ${res.status}`)
  return (await res.json()) as WocUtxo[]
}

export async function getAddressBalance(address: string): Promise<{
  confirmed: number
  unconfirmed: number
}> {
  const res = await fetch(`${wocApiBase()}/address/${address}/balance`)
  if (!res.ok) throw new Error(`WoC balance ${res.status}`)
  return (await res.json()) as { confirmed: number; unconfirmed: number }
}

export async function broadcastRawTx(rawHex: string): Promise<string> {
  const res = await fetch(`${wocApiBase()}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawHex }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WoC broadcast ${res.status}: ${text}`)
  // API returns txid as plain string or JSON
  try {
    const j = JSON.parse(text)
    return typeof j === 'string' ? j : j.txid ?? text
  } catch {
    return text.replace(/"/g, '').trim()
  }
}

export async function getRawTx(txid: string): Promise<string> {
  const res = await fetch(`${wocApiBase()}/tx/${txid}/hex`)
  if (!res.ok) throw new Error(`WoC tx hex ${res.status}`)
  return (await res.text()).trim()
}
