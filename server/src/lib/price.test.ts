import { describe, expect, it } from 'vitest'
import { boxOf, customerPrice, insuranceKop, moneyToKop } from './price.js'
import { normalizeDomain, truncateIp, hashPassword, verifyPassword } from './security.js'
import { mockQuote } from '../ozon/quote.js'

const base = { markupPct: 0, freeFromRub: null, insuranceInPrice: false }

describe('customerPrice', () => {
  it('без наценки и страховки — тариф Ozon вверх до рубля', () => {
    expect(customerPrice(18950, 100000, base)).toMatchObject({ priceRub: 190, free: false })
  })
  it('наценка не поднимает ровную цену на рубль из-за плавающей точки', () => {
    expect(customerPrice(13700, 0, { ...base, markupPct: 15 }).priceRub).toBe(158) // 157.55 → 158
    expect(customerPrice(20000, 0, { ...base, markupPct: 15 }).priceRub).toBe(230)
  })
  it('страховка: 0,6 % суммы, не меньше 10 ₽', () => {
    expect(insuranceKop(100000)).toBe(1000)
    expect(insuranceKop(500000)).toBe(3000)
    expect(customerPrice(20000, 500000, { ...base, insuranceInPrice: true }).priceRub).toBe(230)
  })
  it('бесплатно от порога, включительно', () => {
    expect(customerPrice(20000, 300000, { ...base, freeFromRub: 3000 })).toMatchObject({ priceRub: 0, free: true })
    expect(customerPrice(20000, 299999, { ...base, freeFromRub: 3000 }).free).toBe(false)
  })
  it('порог 0 или пустой — бесплатной доставки нет', () => {
    expect(customerPrice(20000, 999999, { ...base, freeFromRub: 0 }).free).toBe(false)
  })
})

describe('утилиты', () => {
  it('коробка в мм и ключ кеша', () => {
    expect(boxOf(30, 20, 10)).toMatchObject({ key: '300x200x100', dims: { weight_g: 500 } })
    expect(boxOf(30, 20, 10, 1200)).toMatchObject({ key: '300x200x100-1200g', dims: { weight_g: 1200 } })
  })
  it('сумма Ozon в копейки', () => {
    expect(moneyToKop('125.50')).toBe(12550)
    expect(moneyToKop('abc')).toBeNull()
  })
  it('домен из Origin и ручного ввода', () => {
    expect(normalizeDomain('https://www.Shop.ru')).toBe('shop.ru')
    expect(normalizeDomain('shop.ru/catalog')).toBe('shop.ru')
    expect(normalizeDomain('http://project123.tilda.ws:443')).toBe('project123.tilda.ws')
    expect(normalizeDomain('магазин.рф')).toBe('xn--80aairftm.xn--p1ai')
    expect(normalizeDomain('localhost')).toBeNull()
    expect(normalizeDomain('')).toBeNull()
  })
  it('IP для логов усечён', () => {
    expect(truncateIp('93.184.216.34')).toBe('93.184.216.0')
    expect(truncateIp('2a00:1450:4010:c05::71')).toBe('2a00:1450:4010::')
  })
  it('пароль: хеш проверяется, чужой пароль — нет', async () => {
    const h = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })
  it('mock-цена детерминирована и растёт с коробкой', () => {
    expect(mockQuote(1, '300x200x100')).toEqual(mockQuote(1, '300x200x100'))
    expect(mockQuote(1, '600x400x400').deliveryKop).toBeGreaterThan(mockQuote(1, '300x200x100').deliveryKop)
  })
})

import { pointTitle } from '../routes/widget.js'
describe('pointTitle', () => {
  it('безличное «Пункт Ozon» заменяется коротким адресом', () => {
    expect(pointTitle({ name: 'Пункт Ozon', city: 'Краснодар', address: 'Россия, Краснодарский Край, Краснодар, Сормовская улица, 9/1' })).toBe('Ozon, Сормовская улица, 9/1')
    expect(pointTitle({ name: 'ПВЗ на Ленина', city: 'Москва', address: 'Москва, ул. Ленина, 1' })).toBe('ПВЗ на Ленина')
  })
})
