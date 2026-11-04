import { type ApprovalRow, json, type RunRow } from '@factorix/db'
import type { DecideApprovalInput } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { badRequest, conflict, notFound } from '../lib/errors'
import { emit } from '../lib/outbox'
import { advanceIssue } from './pipeline'

/** These gates are not a yes or a no, so the decision has to name a way forward. */
const CHOICES: Partial<Record<ApprovalRow['kind'], NonNullable<DecideApprovalInput['choice']>[]>> = {
  partial_merge: ['retry', 'revert', 'keep'],
  revert_blocked: ['retry', 'keep'],
}

export async function decideApproval(
  deps: Pick<AppDeps, 'db'>,
  orgId: string,
  approvalId: string,
  actorId: string | null,
  input: DecideApprovalInput,
  via = 'ui',
): Promise<void> {
  const { db } = deps
  const gateIssueId = await db.transaction(async (trx) => {
    const approval = await trx<ApprovalRow>('approvals').where({ id: approvalId, orgId }).forUpdate().first()
    if (!approval) throw notFound('Approval')
    if (approval.status !== 'pending') throw conflict(`This approval was already ${approval.status}`)
    const choices = CHOICES[approval.kind]
    if (choices ? input.decision !== 'approved' || !input.choice || !choices.includes(input.choice) : input.choice !== undefined) {
      throw badRequest(choices ? `Choose one of: ${choices.join(', ')}` : 'This approval takes a yes or a no')
    }
    await trx('approvals')
      .where({ id: approvalId })
      .update({
        status: input.decision,
        decidedBy: actorId,
        decidedAt: trx.fn.now(),
        decision: json({ message: input.message, updatedInput: input.updatedInput, choice: input.choice, via }),
      })
    await writeAudit(trx, {
      orgId,
      actorAccountId: actorId,
      actorKind: actorId ? 'human' : 'system',
      action: `approval.${input.decision}`,
      targetType: 'approval',
      targetId: approvalId,
      metadata: { kind: approval.kind, via, choice: input.choice, issueId: approval.issueId, runId: approval.runId },
    })
    await emit(trx, orgId, { type: 'notify', kind: 'approval', id: approvalId })

    if (approval.kind === 'tool' || approval.kind === 'question') {
      if (!approval.runId || !approval.runnerApprovalId) return null
      const run = await trx<RunRow>('runs').where({ id: approval.runId }).forUpdate().first()
      if (!run) return null
      if (run.state === 'suspended') {
        await emit(trx, orgId, { type: 'run.enqueue', runId: run.id })
        return null
      }
      await trx('run_commands').insert({
        runId: run.id,
        createdBy: actorId,
        payload: json({
          type: 'approval.decide',
          approvalId: approval.runnerApprovalId,
          decision: input.decision === 'approved' ? 'approve' : 'reject',
          updatedInput: input.updatedInput,
          message: input.message,
        }),
      })
      await emit(trx, orgId, { type: 'run.ping', runId: run.id })
      return null
    }
    return approval.issueId
  })
  if (gateIssueId) await advanceIssue(db, gateIssueId, { type: 'approval.decided', decision: input.decision, choice: input.choice })
}

export async function expireApprovals(deps: Pick<AppDeps, 'db'>): Promise<number> {
  const { db } = deps
  const expired = await db<ApprovalRow>('approvals').where({ status: 'pending' }).whereNotNull('expiresAt').andWhere('expires_at', '<', db.fn.now())
  for (const approval of expired) {
    if (approval.kind === 'plan' || approval.kind === 'merge') {
      const changed = await db('approvals').where({ id: approval.id, status: 'pending' }).update({ status: 'expired', decidedAt: db.fn.now() })
      if (changed > 0 && approval.issueId) await advanceIssue(db, approval.issueId, { type: 'approval.decided', decision: 'expired' })
    } else {
      await decideApproval(deps, approval.orgId, approval.id, null, { decision: 'rejected', message: 'Nobody answered in time.' }, 'timeout').catch(
        () => undefined,
      )
    }
  }
  return expired.length
}
