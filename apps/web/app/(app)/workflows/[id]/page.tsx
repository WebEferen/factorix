'use client'

import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useMe, useWorkflow } from '@/modules/lib/data'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { ErrorState, ListSkeleton } from '@/modules/ui'
import { WorkflowEditor } from '@/modules/workflows/editor'

const CRUMBS = [{ label: 'Workflows', href: '/workflows' }]

export default function WorkflowPage() {
  const { id } = useParams<{ id: string }>()
  const { data, error, mutate, isValidating } = useWorkflow(id)
  const { data: me } = useMe()
  // The editor owns the draft once it mounts and saves over the server's copy, so it must not start from a stale cached one.
  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    if (data && !isValidating) setFresh(true)
  }, [data, isValidating])

  if (error && !data)
    return (
      <>
        <PageHeader crumbs={CRUMBS} />
        <PageBody>
          <ErrorState error={error} retry={() => void mutate()} />
        </PageBody>
      </>
    )
  if (!data || !me || !fresh)
    return (
      <>
        <PageHeader crumbs={CRUMBS} />
        <PageBody>
          <ListSkeleton rows={4} />
        </PageBody>
      </>
    )
  return <WorkflowEditor key={id} workflow={data.workflow} canEdit={me.account.role === 'admin'} />
}
