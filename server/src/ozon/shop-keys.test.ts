import { randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

process.env.SHOP_KEYS_KEY = randomBytes(32).toString('base64')
let m: typeof import('./shop-keys.js')
beforeAll(async () => { m = await import('./shop-keys.js') })

describe('normalizePhone', () => {
  it.each([
    ['+7 (999) 123-45-67', '+79991234567'],
    ['89991234567', '+79991234567'],
    ['9991234567', '+79991234567'],
    ['7 999 123 45 67', '+79991234567'],
    ['+7 (495) 123-45-67', null],
    ['12345', null],
    ['', null],
  ])('%s → %s', (raw, want) => {
    expect(m.normalizePhone(raw)).toBe(want)
  })
})

describe('шифрование секрета', () => {
  it('туда и обратно, каждый раз разный шифротекст', () => {
    const a = m.encryptSecret('secret-123'), b = m.encryptSecret('secret-123')
    expect(a).not.toBe(b)
    expect(a).not.toContain('secret-123')
    expect(m.decryptSecret(a)).toBe('secret-123')
  })
  it('подменённый шифротекст не расшифровывается', () => {
    const buf = Buffer.from(m.encryptSecret('secret-123'), 'base64')
    buf[buf.length - 1] ^= 1
    expect(() => m.decryptSecret(buf.toString('base64'))).toThrow()
  })
})

describe('phoneHash', () => {
  it('стабилен и не содержит номера', () => {
    expect(m.phoneHash('+79991234567')).toBe(m.phoneHash('+79991234567'))
    expect(m.phoneHash('+79991234567')).not.toContain('9991234567')
    expect(m.phoneHash('+79991234567')).not.toBe(m.phoneHash('+79991234568'))
  })
})

describe('shopAccount', () => {
  it('расшифровывает ключи и просит только нужные скоупы', () => {
    const acc = m.shopAccount({ id: 's1', ozon_client_id: 'cid-12345678', ozon_secret_enc: m.encryptSecret('sec'), ozon_phone: '+79991234567', ozon_keys_status: 'ok' })
    expect(acc?.creds).toEqual({ clientId: 'cid-12345678', clientSecret: 'sec', scopes: [
      'delivery-api.delivery-point', 'delivery-api.delivery', 'delivery-api.order', 'delivery-api.dropoff-point', 'delivery-api.shipment-method',
    ] })
  })
  it('без ключей — null', () => {
    expect(m.shopAccount({ id: 's1', ozon_client_id: null, ozon_secret_enc: null, ozon_phone: null, ozon_keys_status: null })).toBeNull()
  })
})

it('maskClientId', () => {
  expect(m.maskClientId('7f82276a-1111-2222-3333-444455556666')).toBe('7f8227…6666')
})
