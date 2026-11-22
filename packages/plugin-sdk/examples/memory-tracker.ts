import { type Comment, definePlugin, type Issue, type Label, type State } from '../src/index.js'
import { serve } from '../src/node.js'

const STATES: State[] = [
  { id: 'todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'doing', name: 'In Progress', type: 'started', position: 1 },
  { id: 'review', name: 'In Review', type: 'started', position: 2 },
  { id: 'done', name: 'Done', type: 'completed', position: 3 },
  { id: 'dropped', name: 'Canceled', type: 'canceled', position: 4 },
]
const TEAM = { id: 'demo', key: 'DEMO', name: 'Demo board' }

// Everything lives in this process and is gone when it stops. A real plugin calls the service it wraps instead.
const issues = new Map<string, Issue>()
const comments: Comment[] = []
const labels: Label[] = []
let counter = 0
const now = () => new Date().toISOString()
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)

export const plugin = definePlugin({
  name: 'Memory tracker',
  version: '0.1.0',
  description: 'An example tracker that keeps its issues in memory',
  connection: { fields: [{ key: 'owner', label: 'Board owner', type: 'text', placeholder: 'Sam' }] },
  settings: { fields: [{ key: 'greeting', label: 'Greeting on the board page', type: 'text', placeholder: 'Hello' }] },
  pages: [
    {
      key: 'board',
      label: 'Demo board',
      render: (context) => `<!doctype html>
<meta charset="utf-8">
<style>body { font: 14px system-ui; margin: 24px; color: #222 } li { margin: 4px 0 } small { color: #777 }</style>
<h1>${escapeHtml(context.settings.greeting ?? 'Hello')}, ${escapeHtml(context.account.name)}</h1>
<p><small>${escapeHtml(context.org.name)} · ${issues.size} issues</small></p>
<ul>${[...issues.values()].map((issue) => `<li><b>${escapeHtml(issue.identifier)}</b> ${escapeHtml(issue.title)} <small>${escapeHtml(issue.stateName)}</small></li>`).join('')}</ul>`,
    },
  ],
  tracker: (connection) => ({
    async viewer() {
      return { id: 'memory', name: connection.config.owner ?? 'Memory tracker', email: null }
    },
    async listTeams() {
      return [TEAM]
    },
    async listWorkflowStates() {
      return STATES
    },
    async listLabels() {
      return labels
    },
    async listIssues(query) {
      const nodes = [...issues.values()]
        .filter((issue) => !query.updatedAfter || issue.updatedAt > query.updatedAfter)
        .filter((issue) => !query.closedSince || !['completed', 'canceled'].includes(issue.stateType) || issue.updatedAt > query.closedSince)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
      return { nodes, nextCursor: null }
    },
    async getIssue(id) {
      return issues.get(id) ?? null
    },
    async listComments(issueId) {
      return comments.filter((comment) => comment.issueId === issueId)
    },
    async createIssue(input) {
      const state = STATES.find((candidate) => candidate.id === input.stateId) ?? (STATES[0] as State)
      counter += 1
      const issue: Issue = {
        id: `issue-${counter}`,
        identifier: `${TEAM.key}-${counter}`,
        title: input.title,
        description: input.description ?? null,
        url: null,
        priority: input.priority ?? 0,
        teamId: TEAM.id,
        projectId: null,
        stateId: state.id,
        stateName: state.name,
        stateType: state.type,
        assigneeId: null,
        assigneeName: null,
        creatorId: null,
        creatorName: input.creatorName ?? null,
        labels: labels.filter((label) => input.labelIds?.includes(label.id)),
        createdAt: now(),
        updatedAt: now(),
        archivedAt: null,
      }
      issues.set(issue.id, issue)
      return issue
    },
    async updateIssueState(issueId, stateId) {
      const issue = issues.get(issueId)
      const state = STATES.find((candidate) => candidate.id === stateId)
      if (!issue || !state) throw new Error('Unknown issue or status')
      Object.assign(issue, { stateId: state.id, stateName: state.name, stateType: state.type, updatedAt: now() })
    },
    async updateIssueLabels(issueId, change) {
      const issue = issues.get(issueId)
      if (!issue) throw new Error('Unknown issue')
      const kept = issue.labels.filter((label) => !change.remove?.includes(label.id))
      const added = labels.filter((label) => change.add?.includes(label.id) && !kept.some((item) => item.id === label.id))
      Object.assign(issue, { labels: [...kept, ...added], updatedAt: now() })
    },
    async createLabel(input) {
      const label: Label = { id: `label-${labels.length + 1}`, name: input.name, parentId: input.parentId ?? null, isGroup: input.isGroup ?? false }
      labels.push(label)
      return label
    },
    async comment(issueId, body) {
      const comment: Comment = { id: `comment-${comments.length + 1}`, issueId, body, authorId: null, authorName: 'Factorix', createdAt: now() }
      comments.push(comment)
      return { id: comment.id }
    },
  }),
})

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const secret = process.env.PLUGIN_SECRET
  if (!secret) throw new Error('Set PLUGIN_SECRET to the secret you will type into Factorix, 16 characters or more')
  const port = Number(process.env.PORT ?? 8787)
  await serve(plugin, { secret, port })
  console.log(`Memory tracker on http://localhost:${port}/factorix`)
}
