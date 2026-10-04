import { randomUUID } from 'node:crypto'
import type { ProviderUsage } from './common.js'

export interface ResetConfirmation {
  ticket: string
  expiresAt: number
  creditExpiresAt?: number
  weeklyUsedPercent: number
}

/** Manual-only redemption. Tickets are single-use; uncertain submissions park the account. */
export class ResetRedemption {
  private tickets = new Map<string, { account: string; creditId: string; expiresAt: number }>()
  private busy = new Set<string>()
  private uncertain = new Set<string>()
  constructor(
    private readonly read: (account: string, signal: AbortSignal) => Promise<ProviderUsage>,
    private readonly consume: (account: string, creditId: string, requestId: string, signal: AbortSignal) => Promise<void>,
    private readonly invalidate: (account: string) => void,
  ) {}

  private eligible(usage: ProviderUsage): number {
    const weekly = usage.windows?.find(w => w.kind === 'weekly' && w.scope === undefined)
    if (!weekly || !Number.isFinite(weekly.usedPercent) || weekly.usedPercent < 80
      || weekly.resetsAt === undefined || weekly.resetsAt <= Date.now()) {
      throw new Error('Reset blocked: fresh weekly usage must be at least 80%.')
    }
    if (usage.resetCreditsError) throw new Error('Reset credits could not be verified.')
    return weekly.usedPercent
  }

  async prepare(account: string, signal: AbortSignal): Promise<ResetConfirmation> {
    if (this.busy.has(account) || this.uncertain.has(account)) throw new Error('Reset blocked: an operation is pending or its outcome is uncertain. Check Codex before retrying.')
    const usage = await this.read(account, signal)
    const weeklyUsedPercent = this.eligible(usage)
    const credit = usage.resetCredits?.filter(c => c.id && (c.expiresAt === undefined || c.expiresAt > Date.now()))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0]
    if (!credit?.id) throw new Error('No available reset credit.')
    for (const [key, value] of this.tickets) if (value.account === account || value.expiresAt <= Date.now()) this.tickets.delete(key)
    const ticket = randomUUID()
    const expiresAt = Date.now() + 60_000
    this.tickets.set(ticket, { account, creditId: credit.id, expiresAt })
    return { ticket, expiresAt, weeklyUsedPercent, ...(credit.expiresAt === undefined ? {} : { creditExpiresAt: credit.expiresAt }) }
  }

  async redeem(account: string, ticket: string, signal: AbortSignal): Promise<void> {
    const pending = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (!pending || pending.account !== account || pending.expiresAt <= Date.now()) throw new Error('Confirmation expired. Start again.')
    if (this.busy.has(account) || this.uncertain.has(account)) throw new Error('Reset blocked: operation pending or uncertain.')
    this.busy.add(account)
    try {
      const usage = await this.read(account, signal)
      this.eligible(usage)
      if (!usage.resetCredits?.some(c => c.id === pending.creditId && (c.expiresAt === undefined || c.expiresAt > Date.now()))) throw new Error('The selected reset is no longer available.')
      // Mark before submission: no blind retry after transport or response ambiguity.
      this.uncertain.add(account)
      try {
        await this.consume(account, pending.creditId, randomUUID(), signal)
      } catch {
        throw new Error('Reset outcome could not be confirmed. Do not retry or restart to bypass this block; verify credits and limits in Codex first.')
      }
      this.uncertain.delete(account)
    } finally {
      this.invalidate(account)
      this.busy.delete(account)
    }
  }
}
