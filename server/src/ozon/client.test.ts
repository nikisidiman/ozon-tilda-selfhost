import { describe, expect, it } from 'vitest'
import { tokenHasDeliveryAccess } from './client.js'

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

describe('tokenHasDeliveryAccess', () => {
  it('ключи Ozon Доставки: есть delivery-api в scope или permissions', () => {
    expect(tokenHasDeliveryAccess(jwt({ scope: ['delivery-api.all'] }))).toBe(true)
    expect(tokenHasDeliveryAccess(jwt({ scope: ['delivery-api.order', 'delivery-api.delivery'] }))).toBe(true)
    expect(tokenHasDeliveryAccess(jwt({ permissions: { 'delivery-api': {} } }))).toBe(true)
  })

  it('ключи кабинета продавца: прав на Доставку нет', () => {
    expect(tokenHasDeliveryAccess(jwt({ scope: ['seller-api.products'], permissions: { 'seller-api': {} } }))).toBe(false)
  })

  it('токен без разбираемых прав не считается чужим', () => {
    expect(tokenHasDeliveryAccess('opaque-token')).toBeNull()
    expect(tokenHasDeliveryAccess('a.!!!.b')).toBeNull()
    expect(tokenHasDeliveryAccess(jwt({ sub: 'x' }))).toBeNull()
  })
})
