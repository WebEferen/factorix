import type { ReviewOutput } from './phases'

const SEVERITIES = ['blocker', 'major', 'minor', 'nit']

/** The note a review leaves on a merge request. Given comments, it lists them, for projects that keep reviews off the diff. */
export function reviewNote(output: Pick<ReviewOutput, 'verdict' | 'summary'>, comments: ReviewOutput['comments'] = []): string {
  const verdict = `**Review verdict: ${output.verdict === 'approve' ? 'approve' : 'changes requested'}**\n\n${output.summary}`
  if (comments.length === 0) return verdict
  const findings = [...comments]
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .map((comment) => `- **${comment.severity}** \`${comment.path}:${comment.line}\`: ${comment.body.trim().replace(/\n/g, '\n  ')}`)
  return `${verdict}\n\n**Findings**\n\n${findings.join('\n')}`
}
