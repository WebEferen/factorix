'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { ApiError, api } from '@/modules/lib/api'
import { Button, Field, Input } from '@/modules/ui'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void api.get<{ setUp: boolean }>('/api/auth/status').then((status) => {
      if (!status.setUp) router.replace('/setup')
    })
  }, [router])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await api.post('/api/auth/login', { email, password })
      window.location.href = '/inbox'
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not log in. Try again.')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h1 className="mb-1 text-2xl font-bold">Log in</h1>
      <Field label="Email">
        <Input type="email" autoComplete="email" required autoFocus value={email} onChange={(event) => setEmail(event.target.value)} />
      </Field>
      <Field label="Password" error={error ?? undefined}>
        <Input
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(error)}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" loading={loading} className="mt-1 w-full">
        Log in
      </Button>
    </form>
  )
}
