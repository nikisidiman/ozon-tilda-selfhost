import type { Context } from 'hono'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
}

/** Отдаёт файл из dir по относительному пути. Выход за пределы dir и неизвестные типы — 404. */
export async function serveFile(c: Context, dir: string, rel: string, cache = 'public, max-age=300'): Promise<Response> {
  const ext = extname(rel)
  const type = TYPES[ext]
  const full = normalize(join(dir, rel))
  if (!type || !full.startsWith(normalize(dir) + sep)) return c.notFound()
  try {
    const data = await readFile(full)
    c.header('Content-Type', type)
    c.header('Cache-Control', cache)
    return c.body(data)
  } catch {
    return c.notFound()
  }
}

// Внутри контейнера файлы не меняются, поэтому отпечаток считаем один раз на файл.
const versions = new Map<string, string>()

/** Дописывает к ссылкам на общие файлы (`${base}/assets/x.css`) ?v=<отпечаток содержимого>:
 *  после выкладки адрес меняется, и браузер сразу берёт новый файл, а не старый из кеша. */
export async function versionAssets(html: string, dir: string, base: string): Promise<string> {
  const prefix = `${base}/assets/`
  const names = new Set<string>()
  for (const m of html.matchAll(/\/assets\/([\w.-]+)/g)) names.add(m[1])
  for (const name of names) {
    if (!versions.has(name)) {
      try { versions.set(name, createHash('sha256').update(await readFile(join(dir, name))).digest('hex').slice(0, 10)) } catch { continue }
    }
    html = html.replaceAll(`${prefix}${name}"`, `${prefix}${name}?v=${versions.get(name)}"`)
  }
  return html
}
