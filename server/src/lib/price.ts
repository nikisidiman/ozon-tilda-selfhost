// Цена доставки для покупателя. Чистые функции, без сети — покрыты тестами.
// Как считает Ozon (замеры 06.10.2026, отгрузка из Москвы): доставка зависит
// от ПВЗ и объёма коробки, не от веса и объявленной стоимости; страховка —
// 0,6 % объявленной стоимости, не меньше 10 ₽.

export interface ShopPricing {
  markupPct: number
  freeFromRub: number | null
  insuranceInPrice: boolean
}

export function insuranceKop(declaredKop: number): number {
  const v = Math.max(0, Math.round(declaredKop))
  return Math.max(1000, Math.round(v * 0.006))
}

export interface CustomerPrice {
  /** Что платит покупатель, рубли. 0 — бесплатно. */
  priceRub: number
  free: boolean
  /** Сколько, по расчёту, спишет Ozon с магазина (доставка + страховка, если считаем её). */
  ozonKop: number
  insuranceKop: number
}

export function customerPrice(deliveryKop: number, goodsKop: number, shop: ShopPricing): CustomerPrice {
  const ins = shop.insuranceInPrice ? insuranceKop(goodsKop) : 0
  const ozonKop = Math.max(0, Math.round(deliveryKop)) + ins
  if (shop.freeFromRub !== null && shop.freeFromRub > 0 && goodsKop >= shop.freeFromRub * 100) {
    return { priceRub: 0, free: true, ozonKop, insuranceKop: ins }
  }
  // Сначала округляем копейки до целых, потом вверх до рубля: иначе плавающая
  // точка поднимает ровную цену на рубль (13700 × 1.15 = 15755.0000…1).
  const kop = Math.round(ozonKop * (1 + shop.markupPct / 100))
  return { priceRub: Math.ceil(kop / 100), free: false, ozonKop, insuranceKop: ins }
}

/** Коробка в мм для Ozon и ключ кеша. Вес — средней посылки магазина. */
export function boxOf(lCm: number, wCm: number, hCm: number, weightG = 500) {
  const dims = { length_mm: lCm * 10, width_mm: wCm * 10, height_mm: hCm * 10, weight_g: weightG }
  return { dims, key: `${dims.length_mm}x${dims.width_mm}x${dims.height_mm}${weightG === 500 ? '' : `-${weightG}g`}` }
}

/** Сумма в копейках из строки Ozon «125.00». Не число — null. */
export function moneyToKop(amount: unknown): number | null {
  const n = typeof amount === 'number' ? amount : Number(String(amount ?? '').replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function kopToMoney(kop: number): string {
  return (Math.round(kop) / 100).toFixed(2)
}
