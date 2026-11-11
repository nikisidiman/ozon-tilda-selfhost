// Настройки из окружения. Секреты — только в .env на сервере (см. env.example).
// Файл .env пишет команда ozon-tilda (deploy/ozon-tilda), руками его править не нужно.

function str(name: string, def?: string): string {
  const v = process.env[name]
  if (v !== undefined && v !== '') return v
  if (def !== undefined) return def
  throw new Error(`Не задана переменная окружения ${name}`)
}

function opt(name: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : v
}

export const config = {
  port: Number(str('PORT', '3000')),
  databaseUrl: str('DATABASE_URL', 'postgres://ozon:ozon@localhost:5432/ozon_tilda'),
  /** Внешний адрес сервиса без завершающего слеша: https://delivery.shop.ru/ozon-tilda */
  publicUrl: str('PUBLIC_URL', 'http://localhost:3000/ozon-tilda'),
  /** Префикс путей, под которым живёт приложение. */
  basePath: str('BASE_PATH', '/ozon-tilda'),
  production: str('NODE_ENV', 'development') === 'production',

  ozon: {
    mode: str('OZON_MODE', 'mock') as 'mock' | 'live',
    clientId: opt('OZON_DELIVERY_CLIENT_ID'),
    clientSecret: opt('OZON_DELIVERY_CLIENT_SECRET'),
    /** Номер с аккаунтом Ozon: без него /v1/order/checkout отвечает recipient_error. */
    servicePhone: opt('OZON_SERVICE_PHONE'),
    /** Сколько промахов кеша (реальных запросов к Ozon) в час. */
    missesPerHour: Number(str('OZON_MISSES_PER_HOUR', '300')),
    /** Ключ шифрования ключей Ozon в базе (32 байта в base64). Генерируется при установке. */
    shopKeysKey: opt('SHOP_KEYS_KEY'),
  },
}
