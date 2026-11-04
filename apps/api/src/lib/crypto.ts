import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface SecretBox {
  encrypt(plaintext: string): { ciphertext: Buffer; nonce: Buffer; keyVersion: number }
  decrypt(input: { ciphertext: Buffer; nonce: Buffer; keyVersion?: number }): string
}

const TAG_BYTES = 16

export function createSecretBox(encodedKey: string): SecretBox {
  const key = Buffer.from(encodedKey, 'base64')
  if (key.length !== 32) throw new Error('FACTORIX_SECRET_KEY must decode to exactly 32 bytes')
  return {
    encrypt(plaintext) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce, keyVersion: 1 }
    },
    decrypt({ ciphertext, nonce }) {
      const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES))
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    },
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
