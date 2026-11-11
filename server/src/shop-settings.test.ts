import { describe, expect, it } from 'vitest'
import { parseDomains } from './shop-settings.js'

describe('parseDomains', () => {
  it('несколько доменов через запятую и пробел, без повторов', () => {
    expect(parseDomains('shop.ru, www.shop.ru https://Shop.ru/catalog')).toEqual(['shop.ru'])
    expect(parseDomains('shop.ru; project1.tilda.ws')).toEqual(['shop.ru', 'project1.tilda.ws'])
  })
  it('мусор — null', () => {
    expect(parseDomains('')).toBeNull()
    expect(parseDomains('shop.ru, localhost')).toBeNull()
  })
})
