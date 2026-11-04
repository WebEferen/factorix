'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { ApiError, api } from '@/modules/lib/api'
import { Button, Field, Input } from '@/modules/ui'

export default function SetupPage() {
  const router = useRouter()
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value })

  useEffect(() => {
    void api.get<{ setUp: boolean }>('/api/auth/status').then((status) => {
      if (status.setUp) router.replace('/login')
    })
  }, [router])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await api.post('/api/auth/setup', form)
      window.location.href = '/projects'
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Setup failed. Try again.')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="mb-1">
        <h1 className="text-2xl font-bold">Set up Factorix</h1>
        <p className="mt-1 text-sm text-ink-2">Create the organization and the first admin account.</p>
      </div>
      <Field label="Organization">
        <Input required placeholder="Acme" value={form.orgName} onChange={set('orgName')} />
      </Field>
      <Field label="Your name">
        <Input required autoFocus autoComplete="name" value={form.name} onChange={set('name')} />
      </Field>
      <Field label="Email">
        <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
      </Field>
      <Field label="Password" hint="At least 10 characters." error={error ?? undefined}>
        <Input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={set('password')} />
      </Field>
      <Button type="submit" variant="primary" loading={loading} className="mt-1 w-full">
        Create organization
      </Button>
    </form>
  )
}
