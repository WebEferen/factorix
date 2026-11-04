import { createDb } from './client'
import { migrate } from './migrate'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')
const db = createDb(url, { max: 1 })
const applied = await migrate(db)
console.log(applied.length ? `applied ${applied.join(', ')}` : 'database is up to date')
await db.destroy()
