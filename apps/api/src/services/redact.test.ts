import { describe, expect, it } from 'vitest'
import { connectionSecretValues, REDACTED, redactTokens, secretValuesOf } from './redact'

describe('redactTokens', () => {
  it('removes credentials in known formats and passwords in URLs', () => {
    const samples = [
      `lin_api_${'a1'.repeat(20)}`,
      `glpat-${'x'.repeat(20)}`,
      `ghp_${'A'.repeat(36)}`,
      'AKIAABCDEFGHIJKLMNOP',
      `sk-ant-api03-${'b2'.repeat(20)}`,
      `sk_live_${'c'.repeat(24)}`,
      `xoxb-1234567890-${'d'.repeat(12)}`,
      `dp.st.dev.${'e'.repeat(30)}`,
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'f'.repeat(20)}`,
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    ]
    for (const sample of samples) expect(redactTokens(`use ${sample} here`)).toBe(`use ${REDACTED} here`)
    expect(redactTokens('postgres://app:hunter2@db:5432/app')).toBe(`postgres://app:${REDACTED}@db:5432/app`)
  })

  it('leaves ordinary text alone', () => {
    const text = 'Run task-runner with sk-learn, see https://example.com/a/b and ABC-123, then deploy to production.'
    expect(redactTokens(text)).toBe(text)
  })
})

describe('secret values to mask', () => {
  it('takes variables whose names say they are secret, and whole tokens', () => {
    expect(secretValuesOf({ API_KEY: 'k-12345678', NODE_ENV: 'production', DB_PASSWORD: 'short', SESSION_SECRET: 'abcdefgh' })).toEqual([
      'k-12345678',
      'abcdefgh',
    ])
    expect(connectionSecretValues('raw-token-value')).toEqual(['raw-token-value'])
    expect(connectionSecretValues(JSON.stringify({ env: { NPM_TOKEN: 'npm-value-1', REGISTRY: 'https://registry.example.com' } }))).toEqual([
      'npm-value-1',
    ])
    expect(connectionSecretValues(JSON.stringify({ Authorization: 'Bearer abcdefgh' }))).toEqual(['Bearer abcdefgh'])
  })
})
