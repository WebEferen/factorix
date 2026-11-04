'use client'

import { AgentForm } from '@/modules/agents/agent-form'
import { PageBody, PageHeader } from '@/modules/shell/page-header'

export default function NewAgentPage() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Agents', href: '/agents' }, { label: 'New agent' }]} />
      <PageBody>
        <div className="mx-auto max-w-2xl p-4 sm:p-6">
          <AgentForm />
        </div>
      </PageBody>
    </>
  )
}
