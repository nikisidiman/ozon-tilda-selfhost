// Команда настройки магазина. Запускается обёрткой deploy/ozon-tilda внутри контейнера:
//   node server/dist/cli/setup.js setup [--steps 2,3,4] [--auto] | summary | show | check | logs [номер заказа или записи журнала]
// Адрес сервера и ключи Ozon (шаги 1 и 5) спрашивает обёртка и пишет в .env —
// здесь остальные шаги, включая инструкции, что сделать в Tilda. Enter в любом вопросе оставляет значение в скобках.

import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { config } from '../config.js'
import { one, pool } from '../db.js'
import { POSTING_SCOPE, SHOP_SCOPES, OzonConfigError, token, tokenHasDeliveryAccess } from '../ozon/client.js'
import { syncPvz } from '../ozon/pvz-sync.js'
import { decryptSecret, normalizePhone } from '../ozon/shop-keys.js'
import {
  accountOfShop, ensureShop, getDomains, getShop, hookUrl, listOrigins, originByCode, originForCity, parseDomains,
  hookDetails, hookSince, markDone, prepareOrigin, siteHasCode, recentHooks, recentOrders, recheckKeys, saveBadge, saveDomains, saveKeys, saveOrders, saveOrigin, savePricing, searchCities, snippet,
  trialQuote, type OrderDims, type Origin, type Shop,
} from '../shop-settings.js'
import { SELLER_KEYS, type KeyStep } from '../ozon/verify-keys.js'

const rl = createInterface({ input: stdin, output: stdout })
// Очередь строк, а не rl.question: ответы, поданные заранее (printf … | ozon-tilda), иначе теряются.
const lines: string[] = []
const waiting: ((line: string | null) => void)[] = []
let closed = false
rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l) })
rl.on('close', () => { closed = true; for (const w of waiting.splice(0)) w(null) })

async function readAnswer(text: string): Promise<string> {
  stdout.write(text)
  if (lines.length) { const l = lines.shift()!; if (!stdin.isTTY) stdout.write(l + '\n'); return l }
  if (closed) throw new Error('ввод закончился раньше вопросов')
  const l = await new Promise<string | null>((r) => waiting.push(r))
  if (l === null) throw new Error('ввод закончился раньше вопросов')
  if (!stdin.isTTY) stdout.write(l + '\n')
  return l
}
const LINE = '─'.repeat(52)

function section(title: string) { console.log(`\n── ${title} ${LINE.slice(title.length + 4)}`) }
function hint(text: string) { console.log(`    ↳ ${text}`) }

/** Спросить, пока ответ не разберётся. Пустой ответ — значение по умолчанию (если оно есть). */
async function ask<T>(question: string, def: string | null, parse: (s: string) => T | string): Promise<T> {
  for (;;) {
    const raw = (await readAnswer(`  ${question}${def !== null ? ` [${def}]` : ''}: `)).trim()
    const input = raw === '' && def !== null ? def : raw
    if (input === '') { console.log('    ✕ Нужен ответ'); continue }
    const r = parse(input)
    if (typeof r === 'string' && r.startsWith('✕')) { console.log(`    ${r}`); continue }
    return r as T
  }
}

// «l» и «т» — те же клавиши, что «д» и «n», в другой раскладке.
function yesNo(s: string): boolean | string {
  const v = s.toLowerCase()
  if (['д', 'да', 'y', 'yes', 'l'].includes(v)) return true
  if (['н', 'нет', 'n', 'no', 'т'].includes(v)) return false
  return '✕ Ответьте «д» или «н»'
}
const yn = (b: boolean) => (b ? 'Д' : 'н')
const ynLabel = (b: boolean) => (b ? 'Д/н' : 'д/Н')

function parseBox(s: string): { l: number; w: number; h: number } | string {
  const n = s.split(/[\sx×х*,]+/i).filter(Boolean).map(Number)
  if (n.length !== 3 || n.some((v) => !Number.isInteger(v) || v < 1 || v > 200)) return '✕ Три целых числа в сантиметрах от 1 до 200, например 40x30x15'
  return { l: n[0], w: n[1], h: n[2] }
}

function parseRub(s: string): number | string {
  const v = Number(s.replace(/\s/g, ''))
  return Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : '✕ Целое число рублей, 0 — не делать'
}

function parseMarkup(s: string): number | string {
  const v = Number(s.replace(',', '.').replace('%', ''))
  return Number.isFinite(v) && v >= 0 && v <= 300 ? Math.round(v * 100) / 100 : '✕ Число от 0 до 300'
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
  return `${n} ${w}`
}

function printSteps(steps: KeyStep[]) {
  for (const s of steps) console.log(`    ${s.ok ? '✓' : '✕'} ${s.title}${s.message ? ` — ${s.message}` : ''}`)
}

// —— Ключи из .env → в базу ——

/** Ключи вводятся в обёртке (в .env). В базу кладём их копию для заказов и проверки номера. */
async function syncKeys(s: Shop): Promise<KeyStep[] | null> {
  const { clientId, clientSecret, servicePhone } = config.ozon
  if (!clientId || !clientSecret) return null
  const phone = normalizePhone(servicePhone ?? '') ?? ''
  let same = s.ozon_client_id === clientId && s.ozon_phone === phone && !!s.ozon_secret_enc
  if (same) {
    try { same = decryptSecret(s.ozon_secret_enc!) === clientSecret } catch { same = false }
  }
  return same ? recheckKeys(s) : saveKeys(s, clientId, clientSecret, phone)
}

async function quickTokenCheck(): Promise<boolean> {
  if (config.ozon.mode === 'mock') {
    console.log('  Тестовый режим: ключей Ozon нет, цены условные.')
    return true
  }
  const { clientId, clientSecret } = config.ozon
  process.stdout.write('  Проверяю ключи в Ozon… ')
  try {
    const t = await token({ clientId: clientId!, clientSecret: clientSecret!, scopes: SHOP_SCOPES }, true)
    if (tokenHasDeliveryAccess(t) === false) {
      console.log('✕ это не те ключи')
      hint(SELLER_KEYS)
      return false
    }
    console.log('✓ ключи работают')
    return true
  } catch (e) {
    console.log(`✕ ${e instanceof OzonConfigError ? e.message : 'ошибка'}`)
    hint('Запустите ozon-tilda setup ещё раз и вставьте Client ID и Client Secret целиком')
    return false
  }
}

// —— Справочник пунктов ——

async function ensurePvz() {
  const count = async () => Number((await one<{ n: string }>('select count(*) n from pvz where enabled'))?.n ?? 0)
  if (config.ozon.mode !== 'live' || (await count()) > 1000) return
  console.log('  Загружаю справочник пунктов Ozon — при первом запуске это 5–15 минут…')
  const log = console.log, err = console.error
  console.log = console.error = () => {}   // журнал синхронизации на экран не нужен — показываем счётчик
  const timer = setInterval(async () => { stdout.write(`\r    загружено пунктов: ${await count()}   `) }, 5000)
  try {
    await syncPvz()
  } finally {
    clearInterval(timer)
    console.log = log; console.error = err
  }
  const n = await count()
  if (n > 0) console.log(`\r    ✓ пунктов в справочнике: ${n}          `)
  else {
    console.log('\r    ✕ Справочник не загрузился.')
    hint('Проверьте, что в приложении Ozon отмечено «Методы для получения информации по пунктам выдачи»')
    hint('(или «Все методы»), и запустите ozon-tilda setup ещё раз')
  }
}

// —— Город отгрузки ——

async function chooseOrigin(current: Origin | null): Promise<Origin> {
  const origins = await listOrigins()
  const printList = (all: boolean) => {
    const shown = all ? origins : origins.slice(0, 5)
    const cells = shown.map((o, i) => `${String(i + 1).padStart(2)}) ${o.city}`)
    for (let i = 0; i < cells.length; i += 4) console.log('    ' + cells.slice(i, i + 4).map((c) => c.padEnd(22)).join(''))
    if (!all) console.log(`    … (весь список — введите ?)`)
  }
  console.log('  Введите название города или номер из списка:')
  printList(false)
  for (;;) {
    const raw = (await readAnswer(`  Город${current ? ` [${current.city}]` : ''}: `)).trim()
    if (raw === '' && current) return current
    if (raw === '?') { printList(true); continue }
    if (/^\d+$/.test(raw)) {
      const o = origins[Number(raw) - 1]
      if (o) return o
      console.log(`    ✕ Номер от 1 до ${origins.length}`)
      continue
    }
    const found = await searchCities(raw)
    if (!found.length) { console.log('    ✕ Не нашёл такой город, проверьте написание'); continue }
    let pick = found[0]
    if (found.length > 1 || found[0].city.toLowerCase() !== raw.toLowerCase()) {
      console.log('  Нашлось:')
      found.forEach((c, i) => console.log(`    ${i + 1}) ${c.city} — ${plural(c.points, 'пункт', 'пункта', 'пунктов')}, например ${c.sample}`))
      const n = await ask('Номер', '1', (s) => {
        const v = Number(s)
        return Number.isInteger(v) && v >= 1 && v <= found.length ? v : `✕ Номер от 1 до ${found.length}`
      })
      pick = found[n - 1]
    }
    return originForCity(pick.city)
  }
}

// —— Команды ——

// Шаги мастера по порядку. 1 (адрес сервера) и 5 (ключи Ozon) спрашивает обёртка deploy/ozon-tilda:
// они пишут .env и перезапускают сервис. Остальные — здесь. Шаги 3, 4, 6 и 10 — действия в Tilda:
// терминал объясняет, что нажать, и ждёт подтверждения.
const NODE_STEPS = [2, 3, 4, 6, 7, 8, 9, 10]

/** `setup --steps 2,3,4` — эти шаги по порядку; `--auto` — добавить незаполненные, без которых не обойтись. */
function chosenSteps(): number[] {
  const i = process.argv.indexOf('--steps')
  if (i < 0) return NODE_STEPS
  const set = new Set((process.argv[i + 1] ?? '').split(/[\s,]+/).map(Number).filter((n) => NODE_STEPS.includes(n)))
  return NODE_STEPS.filter((n) => set.has(n))
}

function accepted(text: string) { console.log(`    ✓ принято: ${text}`) }
function say(...lines: string[]) { for (const l of lines) console.log(`  ${l}`) }

const boxText = (s: Shop) => `${s.box_l_cm}×${s.box_w_cm}×${s.box_h_cm} см, ${kg(s.box_weight_g)} кг`
const kg = (g: number) => String(g / 1000).replace('.', ',')
const dateText = (iso: string | undefined) => iso ? new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : ''

/** Ждать, пока клиент сделает действие в Tilda. true — сделал, false — отложил. */
async function waitDone(what: string): Promise<boolean> {
  const raw = (await readAnswer(`\n  ${what}? Enter — готово, «п» — пропустить и сделать позже: `)).trim().toLowerCase()
  const later = ['п', 'g', 'пропустить'].includes(raw)
  console.log(later ? '    ↳ отложено — вернуться: ozon-tilda setup и номер шага' : '    ✓ отмечено')
  return !later
}

async function setup() {
  let s = await ensureShop()
  const steps = chosenSteps()
  if (process.argv.includes('--auto')) {
    const hasDomains = (await getDomains(s.id)).length > 0
    const need: [number, boolean, boolean][] = [
      [2, !hasDomains, steps.some((n) => n === 3 || n === 10)],
      [7, !s.origin_code, steps.includes(10)],
    ]
    for (const [n, missing, wanted] of need) {
      if (missing && wanted && !steps.includes(n)) { steps.push(n); console.log(`  Шаг ${n} ещё не заполнен — спрошу и его.`) }
    }
    steps.sort((a, b) => a - b)
  }
  if (steps.some((n) => n >= 6)) await quickTokenCheck()

  for (const n of steps) {
    s = (await getShop())!
    await STEP_RUNNERS[n](s)
  }
}

const STEP_RUNNERS: Record<number, (s: Shop) => Promise<void>> = {
  2: async (s) => {
    section('2. Сайт на Tilda')
    say('Адрес вашего магазина на Tilda — с него корзина будет обращаться к этому серверу.')
    const now = (await getDomains(s.id)).map((d) => d.domain)
    const doms = await ask('Домен сайта (можно несколько через запятую, например shop.ru, www.shop.ru)', now.length ? now.join(', ') : null,
      (v) => parseDomains(v) ?? '✕ Не похоже на домен, пример: shop.ru')
    await saveDomains(s.id, doms)
    accepted(doms.join(', '))
  },

  3: async (s) => {
    section('3. Код в HEAD — в Tilda')
    say('Код добавляет в корзину выбор пункта выдачи Ozon и расчёт цены доставки.',
      '',
      '1) В Tilda откройте Настройки сайта → Вставка кода (в старом меню: Ещё).',
      '2) В блоке «HTML-код для вставки внутрь HEAD» нажмите «Редактировать код».',
      '3) Вставьте эту строку и сохраните. Если там уже есть другой код — добавьте её отдельной строкой ниже:',
      '',
      `   ${snippet(s)}`,
      '',
      'Публиковать страницы пока не нужно — опубликуем всё один раз в конце.')
    if (await waitDone('Вставили код')) await markDone(s.id, 'head')
  },

  4: async (s) => {
    section('4. Доставка в корзине — в Tilda')
    say('Покупатель выберет в корзине вариант со словом «Озон» — под ним появятся пункты выдачи и цена.',
      '',
      '1) Откройте страницу с корзиной, блок корзины → Контент → поле «Варианты доставки».',
      '   Отметьте «Использовать продвинутый режим настроек…». Если поля нет — добавьте поле',
      '   с типом «Варианты доставки».',
      '2) Настройки сайта → Доставка → в разделе «Свои варианты доставки» нажмите',
      '   «Своя доставка по адресу».',
      '3) Заполните и нажмите «Добавить»:',
      '   • Название в списке — со словом Озон или Ozon, например «Доставка до ПВЗ Озон»;',
      '   • Срок доставки — 0;',
      '   • Стоимость — 0. Настоящие цену и срок подставит виджет.')
    if (await waitDone('Добавили вариант доставки')) await markDone(s.id, 'delivery')
  },

  6: async (s) => {
    section('6. Заказы в Ozon и вебхук')
    say('После оформления заказа Tilda пришлёт его сюда, а сервис создаст отправление',
      'в вашем кабинете Ozon Доставки — с пунктом выдачи, телефоном и именем покупателя.')
    if (!s.ozon_client_id && !config.ozon.clientId) hint('Ключей Ozon нет — заказы начнут уходить, когда вы их введёте (шаг 5)')
    const enabled = await ask(`Создавать отправление в кабинете Ozon после заказа? (${ynLabel(s.ozon_orders_enabled || !s.hook_token)})`,
      yn(s.ozon_orders_enabled || !s.hook_token), yesNo)
    await saveOrders(s.id, enabled, enabled && s.ozon_orders_approve)
    if (!enabled) { accepted('не создавать — отправления будете оформлять в кабинете Ozon сами'); return }
    s = (await getShop())!
    const since = new Date()
    say('',
      'Подключите вебхук в Tilda:',
      '1) Настройки сайта → Формы → Webhook.',
      '2) В поле Webhook URL вставьте адрес:',
      '',
      `   ${hookUrl(s)}`,
      '',
      '3) API Method оставьте Off. В «Дополнительных настройках» отметьте:',
      '   • Передавать данные по товарам в заказе — массивом',
      '   • Передавать externalid в товарах',
      '   • Отправлять данные в виде application/json',
      '   • Передавать дополнительные данные в товарах',
      '   • Отправлять только после оплаты — по желанию: тогда приходят только оплаченные заказы',
      '4) Нажмите «Добавить».',
      '5) Откройте блок корзины → Контент → «Подключенные сервисы», отметьте этот Webhook и сохраните.',
      '   Без этого Tilda не будет присылать заказы — это самая частая ошибка.')
    if (await waitDone('Подключили вебхук')) {
      await markDone(s.id, 'hook')
      if (await hookSince(s.id, since)) console.log('    ✓ Tilda прислала проверочный запрос — адрес верный')
      else hint('Проверочного запроса от Tilda не видно. Если адрес вставлен — не страшно, проверим заказом в конце')
    }
    const approve0 = s.ozon_orders_approve
    let approve = await ask(`Сразу подтверждать отправление? (${ynLabel(approve0)})`, yn(approve0), yesNo)
    hint('«Да», если отметили «Отправлять только после оплаты». Иначе подтверждаете в кабинете Ozon сами')
    if (approve && config.ozon.mode === 'live' && !(await canApprove(s))) {
      console.log('    ✕ В приложении Ozon не отмечено «Методы для работы с отправлениями» — подтверждать будете вручную')
      approve = false
    }
    await saveOrders(s.id, true, approve)
    accepted(`создавать${approve ? ' и сразу подтверждать' : ', подтверждать вручную'}`)
  },

  7: async (s) => {
    section('7. Откуда отправляете заказы')
    say('Город, где вы сдаёте посылки в Ozon. От него считается цена и срок доставки.')
    await ensurePvz()
    const origin = await chooseOrigin(await originByCode(s.origin_code))
    await saveOrigin(s.id, origin.code)
    accepted(origin.city)
    s = (await getShop())!
    if (config.ozon.clientId) {
      console.log(`\n  Проверяю ключи для ${origin.city} (пункт приёма, метод доставки)…`)
      const checked = await syncKeys(s)
      if (checked) printSteps(checked)
    }
  },

  8: async (s) => {
    section('8. Расчёт цены')
    say('Цену в корзине Ozon считает по типовой коробке и весу средней посылки. В отправление',
      'уходят габариты товаров из карточек Tilda, если они заполнены у всех товаров корзины;',
      'если хотя бы у одного нет габаритов или веса — эта же типовая коробка.',
      'Габариты и вес задаются в карточке товара в каталоге Tilda (параметры упаковки).')
    const box = await ask('Размер типовой коробки в см, Д×Ш×В', `${s.box_l_cm}x${s.box_w_cm}x${s.box_h_cm}`, parseBox)
    const weightG = await ask('Вес средней посылки, кг', kg(s.box_weight_g), parseKg)
    const free = await ask('Бесплатная доставка от суммы заказа, ₽ (0 — не делать)', String(s.free_from_rub ?? 0), parseRub)
    const markup = await ask('Наценка к цене Ozon, % (0 — без наценки)', String(Number(s.markup_pct)), parseMarkup)
    await savePricing(s.id, { box, weightG, markupPct: markup, freeFromRub: free || null, showBadge: s.show_badge })
    s = (await getShop())!
    accepted(`коробка ${boxText(s)}, бесплатно ${free ? `от ${free} ₽` : 'не делать'}, наценка ${markup} %`)
  },

  9: async (s) => {
    section('9. Иконка Озон')
    say('Небольшой значок Ozon после названия варианта доставки в корзине.')
    const badge = await ask(`Показывать значок? (${ynLabel(s.show_badge)})`, yn(s.show_badge), yesNo)
    await saveBadge(s.id, badge)
    await markDone(s.id, 'badge')
    accepted(badge ? 'показывать' : 'не показывать')
  },

  10: async (s) => {
    section('10. Публикация и проверка')
    say('В Tilda откройте Настройки сайта и нажмите «Опубликовать все страницы» — так на сайте',
      'появятся и код, и вариант доставки. Публикация занимает пару минут.')
    if (await waitDone('Опубликовали все страницы')) await markDone(s.id, 'publish')
    s = (await getShop())!

    await trial(s)
    for (const d of (await getDomains(s.id)).map((x) => x.domain)) {
      const r = await siteHasCode(d, s.public_key)
      console.log(r === 'ok' ? `  ✓ Код на сайте ${d} найден`
        : r === 'missing' ? `  ✕ На ${d} кода нет — проверьте шаг 3 и опубликуйте страницы ещё раз`
        : `  ? ${d} не открылся отсюда — проверьте сами, что сайт работает`)
    }

    section('Итог')
    await printSummary()
    if (!config.publicUrl.startsWith('https://')) {
      console.log('\n  ⚠ У сервера пока нет HTTPS — Tilda не сможет к нему обращаться. Запустите ozon-tilda setup 1, когда DNS обновится.')
    }
    console.log(`
Как проверить вживую:
  1) Откройте сайт в браузере и положите товар в корзину.
  2) В вариантах доставки выберите «…Озон» — появятся выбор пункта выдачи и цена.
  3) Укажите свой телефон (на него должен быть аккаунт Ozon) и оформите заказ.
  4) Здесь выполните ozon-tilda logs — заказ должен быть «принят → создано» (или «подтверждено»).
  5) Проверьте отправление в кабинете Ozon Доставки; если заказ тестовый — отмените его там.

Команды:
  ozon-tilda logs            — последние заказы из Tilda и что с ними в Ozon
  ozon-tilda logs <номер>    — что именно прислала Tilda по заказу
  ozon-tilda show            — настройки, код для HEAD и адрес вебхука
  ozon-tilda setup           — поменять настройки (можно выбрать только нужные шаги)`)
  },
}

function parseKg(s: string): number | string {
  const v = Number(s.replace(',', '.').replace(/\s|кг/gi, ''))
  return Number.isFinite(v) && v >= 0.01 && v <= 100 ? Math.round(v * 1000) : '✕ Вес в килограммах от 0,01 до 100, например 0,5'
}

interface StepRow { n: number; title: string; value: string | null; warn: boolean }

/** Состояние шагов мастера: value null — шаг не сделан. */
async function stepRows(): Promise<StepRow[]> {
  const s = await getShop()
  const w = s?.wizard ?? {}
  const rows: StepRow[] = []
  const row = (n: number, title: string, value: string | null, warn = false) => rows.push({ n, title, value, warn })
  const done = (key: string, text: string) => (w[key] ? `${text} ${dateText(w[key])}` : null)
  const url = config.publicUrl
  const local = /\/\/(localhost|127\.)/.test(url)
  row(1, 'Адрес сервера', local ? null : url.startsWith('https://') ? url.replace(/\/ozon-tilda$/, '') : `${url} — без HTTPS`, !url.startsWith('https://'))
  const domains = s ? (await getDomains(s.id)).map((d) => d.domain) : []
  row(2, 'Сайт на Tilda', domains.length ? domains.join(', ') : null)
  row(3, 'Код в HEAD (Tilda)', done('head', 'вставлен'))
  row(4, 'Доставка в корзине (Tilda)', done('delivery', 'добавлена'))
  const keysBad = !!s?.ozon_keys_status && s.ozon_keys_status !== 'ok'
  row(5, 'Ключи Ozon', config.ozon.mode !== 'live' || !config.ozon.clientId ? null
    : `Client ID ${config.ozon.clientId}${keysBad ? ' — не прошли проверку' : s?.ozon_keys_status === 'ok' ? ', проверены' : ''}`, keysBad)
  row(6, 'Заказы в Ozon и вебхук', !s?.hook_token ? null : !s.ozon_orders_enabled ? 'не создавать'
    : `создавать${s.ozon_orders_approve ? ' и подтверждать' : ''}; вебхук ${w.hook ? 'подключён' : 'не подключён'}`, !!s?.ozon_orders_enabled && !w.hook)
  row(7, 'Город отгрузки', s ? (await originByCode(s.origin_code))?.city ?? null : null)
  row(8, 'Расчёт цены', s?.onboarded_at
    ? `коробка ${boxText(s)}; бесплатно ${s.free_from_rub ? `от ${s.free_from_rub} ₽` : 'нет'}; наценка ${Number(s.markup_pct)} %` : null)
  row(9, 'Иконка Озон', s && (w.badge || s.onboarded_at) ? (s.show_badge ? 'показывать' : 'не показывать') : null)
  row(10, 'Публикация (Tilda)', done('publish', 'опубликовано'))
  return rows
}

/** Что уже настроено — по шагам мастера. Показывается в начале setup и в конце. */
async function printSummary() {
  for (const r of await stepRows()) {
    console.log(`  ${r.value === null ? '—' : r.warn ? '⚠' : '✓'} ${String(r.n).padStart(2)}. ${r.title.padEnd(28)}${r.value ?? 'не сделано'}`)
  }
}

async function summary() {
  console.log('Что уже настроено:')
  await printSummary()
}

/** Номер первого несделанного шага — с него мастер продолжает по Enter. Всё сделано — 1. */
async function next() {
  console.log((await stepRows()).find((r) => r.value === null)?.n ?? 1)
}

async function canApprove(s: Shop): Promise<boolean> {
  const acc = accountOfShop(s)
  if (!acc?.creds) return false
  try {
    await token({ ...acc.creds, scopes: [...acc.creds.scopes, POSTING_SCOPE] }, true)
    return true
  } catch (e) {
    if (e instanceof OzonConfigError) return false
    throw e
  }
}

async function trial(s: Shop) {
  section('Проверка')
  await prepareOrigin(s)
  const t = await trialQuote(s)
  if (!t) { console.log('  ✕ Пробный расчёт не сделать: город отгрузки не выбран или справочник пунктов пуст'); return }
  console.log(`  Пробный расчёт: ${t.from} → ${t.to}, коробка ${boxText(s)}`)
  if (t.quote.ok) console.log(`  ✓ ${t.priceRub} ₽${t.quote.days ? `, ${t.quote.days} дн.` : ''} (пункт: ${t.point})`)
  else console.log(`  ✕ ${t.quote.message}${t.quote.code ? ` (${t.quote.code})` : ''}`)
}

async function show() {
  const s = await getShop()
  if (!s) { console.log('Магазин ещё не настроен — запустите ozon-tilda setup'); return }
  const origin = await originByCode(s.origin_code)
  const domains = await getDomains(s.id)
  const steps = s.ozon_keys_check ?? []
  console.log(`Адрес сервера:        ${config.publicUrl}`)
  console.log(`Режим Ozon:           ${config.ozon.mode === 'live' ? 'боевой' : 'тестовый (цены условные)'}`)
  console.log(`Client ID:            ${s.ozon_client_id ?? '—'}  (секрет сохранён: ${s.ozon_secret_enc ? 'да' : 'нет'})`)
  console.log(`Телефон для Ozon:     ${s.ozon_phone ?? '—'}`)
  console.log(`Проверка ключей:      ${s.ozon_keys_status === 'ok' ? '✓ работают' : s.ozon_keys_status === 'broken' ? '✕ Ozon перестал их принимать' : s.ozon_keys_status ? '✕ не прошла' : '—'}`)
  if (s.ozon_keys_status !== 'ok') printSteps(steps.filter((x) => !x.ok))
  console.log(`Домены магазина:      ${domains.map((d) => d.domain + (d.widget_issue ? ' (в корзине нет варианта Ozon)' : d.last_seen_at ? ' ✓' : '')).join(', ') || '—'}`)
  console.log(`Город отгрузки:       ${origin?.city ?? '—'}`)
  console.log(`Типовая коробка:      ${boxText(s)}`)
  console.log(`Бесплатно от:         ${s.free_from_rub ? `${s.free_from_rub} ₽` : 'не делать'}`)
  console.log(`Наценка:              ${Number(s.markup_pct)} %`)
  console.log(`Иконка Озон:          ${s.show_badge ? 'показывать' : 'не показывать'}`)
  console.log(`Заказы в Ozon:        ${s.ozon_orders_enabled ? `создавать${s.ozon_orders_approve ? ' и сразу подтверждать' : ''}` : 'не создавать'}`)
  console.log(`\nКод для HEAD:  ${snippet(s)}`)
  const url = hookUrl(s)
  if (s.ozon_orders_enabled && url) console.log(`Webhook:       ${url}`)
}

async function check() {
  const s = await getShop()
  if (!s) { console.log('Магазин ещё не настроен — запустите ozon-tilda setup'); return }
  if (!config.publicUrl.startsWith('https://')) console.log('✕ У сервера нет HTTPS — Tilda не сможет к нему обращаться')
  if (await quickTokenCheck() && config.ozon.clientId) {
    const steps = await syncKeys(s)
    if (steps) printSteps(steps)
  }
  await trial((await getShop())!)
}

const ORDER_STATUS: Record<string, string> = {
  creating: 'создаётся', created: 'создано', approved: 'подтверждено', failed: 'Ozon отказал', unknown: 'ответа нет — проверьте в кабинете Ozon',
}
const HOOK_RESULT: Record<string, string> = {
  accepted: 'принят', unknown_token: 'неверный адрес вебхука — скопируйте его заново из ozon-tilda show',
  test: 'проверка от Tilda', disabled: 'заказы в Ozon выключены (ozon-tilda setup, шаг 7)', busy: 'слишком много запросов за час',
  no_order: 'нет номера заказа — это не заказ корзины', no_pvz: 'без пункта Ozon — покупатель выбрал другую доставку или пункт не передан',
}
const when = (d: Date) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })

async function logs() {
  const ref = process.argv[3]
  if (ref) return hookLog(ref)
  const s = await getShop()
  if (!s) { console.log('Магазин ещё не настроен — запустите ozon-tilda setup'); return }

  section('Вебхуки от Tilda')
  const hooks = await recentHooks()
  if (!hooks.length) console.log('Вебхуков ещё не было. Проверьте, что адрес из ozon-tilda show вставлен в Tilda: Настройки сайта → Формы → Webhook')
  for (const h of [...hooks].reverse()) {
    const order = h.tilda_order_id ? `  заказ ${h.tilda_order_id}` : ''
    const status = h.order_status ? ` → ${ORDER_STATUS[h.order_status] ?? h.order_status}` : ''
    console.log(`#${h.id}  ${when(h.at)}${order}  ${HOOK_RESULT[h.result] ?? h.result}${status}`)
  }

  section('Заказы в Ozon')
  const rows = await recentOrders(s.id)
  if (!rows.length) console.log('Заказов в Ozon ещё не было')
  for (const r of rows) {
    console.log(`${when(r.created_at)}  заказ ${r.tilda_order_id}  ${ORDER_STATUS[r.status] ?? r.status}${r.posting_number ? `  № ${r.posting_number}` : ''}`)
    if (r.dims) console.log(`    ${dimsText(r.dims)}`)
    if (r.error) console.log(`    ${r.error}`)
  }
  console.log('\nЧто пришло от Tilda целиком: ozon-tilda logs <номер заказа или записи>. Данные покупателя скрыты.')
}

/** Откуда габариты отправления: из карточек товаров Tilda или типовая коробка магазина. */
function dimsText(d: OrderDims): string {
  const size = `${d.length_mm / 10}×${d.width_mm / 10}×${d.height_mm / 10} см, ${kg(d.weight_g)} кг`
  return d.source === 'items'
    ? `📦 по карточкам товаров Tilda: ${size}`
    : `📦 типовая коробка: ${size} — у части товаров в Tilda нет габаритов или веса`
}

async function hookLog(ref: string) {
  const rows = await hookDetails(ref.replace(/^#/, ''))
  if (!rows.length) { console.log(`В журнале нет заказа или записи ${ref} (хранятся 30 дней)`); return }
  for (const h of rows) {
    console.log(`#${h.id}  ${when(h.at)}  ${HOOK_RESULT[h.result] ?? h.result}`)
    console.log(JSON.stringify(h.body, null, 2))
  }
}

const COMMANDS: Record<string, () => Promise<void>> = { setup, summary, next, show, check, logs }

async function main() {
  const cmd = process.argv[2] ?? 'setup'
  const run = COMMANDS[cmd]
  if (!run) { console.log('Команды: setup, show, check, logs'); process.exitCode = 1; return }
  try {
    await run()
  } finally {
    rl.close()
    await pool.end()
  }
}

main().catch((e) => { console.error('Ошибка:', e instanceof Error ? e.message : e); process.exit(1) })
