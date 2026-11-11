import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveFile } from './lib/static.js'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { config } from './config.js'
import { migrate, q } from './db.js'
import { widget } from './routes/widget.js'
import { hook } from './routes/hook.js'
import { cleanupExpired, truncateIp } from './lib/security.js'
import { clientIp } from './lib/http.js'
import { seedMockPvz } from './ozon/mock-pvz.js'
import { schedulePvzSync } from './ozon/pvz-sync.js'

const ROOT = resolve(process.env.APP_ROOT ?? process.cwd())
const B = config.basePath

const app = new Hono()

// Лог без тел запросов и с усечённым IP.
app.use('*', async (c, next) => {
  const t = Date.now()
  await next()
  const path = new URL(c.req.url).pathname
  if (!path.endsWith('/health')) {
    console.log(`${c.req.method} ${path} ${c.res.status} ${Date.now() - t}ms ip=${truncateIp(clientIp(c))}`)
  }
})

app.onError((e, c) => {
  console.error('[error]', e)
  return c.json({ error: 'internal', message: 'Что-то пошло не так. Попробуйте ещё раз' }, 500)
})

app.get(`${B}/health`, async (c) => {
  await q('select 1')
  return c.json({ ok: true, ozon: config.ozon.mode })
})

app.route(`${B}/api/w`, widget)
app.route(`${B}/api/hook`, hook)

// Виджет: короткий кеш, чтобы правки доезжали до сайта за минуты.
app.get(`${B}/w.js`, async (c) => {
  const js = await readFile(join(ROOT, 'widget/w.js'), 'utf8')
  c.header('Content-Type', 'application/javascript; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  c.header('Access-Control-Allow-Origin', '*')
  return c.body(js.replace('__API_BASE__', `${config.publicUrl}/api/w`))
})

app.get(`${B}/ozon-badge.webp`, (c) => serveFile(c, join(ROOT, 'widget'), 'ozon-badge.webp', 'public, max-age=86400'))

// Страниц у сервиса нет: настройки — командой ozon-tilda setup на сервере.
app.get('/', (c) => c.text('Ozon доставка для Tilda работает'))

async function start() {
  await migrate(join(ROOT, 'db/migrations'))
  await seedMockPvz()
  schedulePvzSync()
  setInterval(() => { cleanupExpired().catch((e) => console.error('[cleanup]', e)) }, 60 * 60_000)
  serve({ fetch: app.fetch, port: config.port }, () => {
    console.log(`[ozon-tilda] ${config.publicUrl} · порт ${config.port} · Ozon: ${config.ozon.mode}`)
  })
}

start().catch((e) => { console.error(e); process.exit(1) })

export { app }
