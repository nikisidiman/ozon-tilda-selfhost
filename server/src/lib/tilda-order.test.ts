import { describe, expect, it } from 'vitest'
import { isTildaTest, maskPersonal, parseParcel, parseTildaBody, pvzOf, shapeOf, tildaOrder } from './tilda-order.js'

const payment = {
  orderid: '1234567890',
  amount: '3750',
  delivery: 'Ozon, пункт выдачи: Ozon 16703, Краснодар, ул. Красная, 1',
  delivery_price: 150,
  products: [
    { name: 'Свеча «Ночной жасмин»', quantity: 2, amount: 3600, price: 1800 },
  ],
}

describe('parseTildaBody', () => {
  it('JSON', () => {
    const b = parseTildaBody(JSON.stringify({ Phone: '+7 (999) 123-45-67', payment }), 'application/json')
    expect(tildaOrder(b)).toMatchObject({ orderId: '1234567890', phone: '+7 (999) 123-45-67', pvzId: 16703, goodsKop: 360000 })
  })
  it('форма, payment JSON-строкой', () => {
    const p = new URLSearchParams({ Name: 'Анна', Phone: '89991234567', payment: JSON.stringify(payment) })
    expect(tildaOrder(parseTildaBody(p.toString(), 'application/x-www-form-urlencoded')))
      .toMatchObject({ name: 'Анна', description: 'Свеча «Ночной жасмин» × 2', pvzId: 16703 })
  })
  it('форма, payment «как массив»', () => {
    const p = new URLSearchParams({
      Phone: '89991234567', 'payment[orderid]': '42', 'payment[amount]': '1950', 'payment[delivery_price]': '150',
      'payment[products][0][name]': 'Спички', 'payment[products][0][quantity]': '1', 'payment[products][0][amount]': '1800',
      ozon_pickup_point: 'Ozon 1006, ул. Морская, 47', ozon_parcel: '100×90×90 мм, 450 г',
    })
    expect(tildaOrder(parseTildaBody(p.toString(), 'application/x-www-form-urlencoded'))).toMatchObject({
      orderId: '42', pvzId: 1006, goodsKop: 180000,
      parcel: { length_mm: 100, width_mm: 90, height_mm: 90, weight_g: 450 },
    })
  })
  it('тестовый запрос Tilda', () => {
    expect(isTildaTest(parseTildaBody('test=test', 'application/x-www-form-urlencoded'))).toBe(true)
  })
})

describe('заказ', () => {
  it('без Ozon в доставке — пункта нет', () => {
    expect(pvzOf({ payment: { delivery: 'СДЭК до двери' } })).toBeNull()
  })
  it('сумма товаров без доставки, если позиций нет', () => {
    expect(tildaOrder({ payment: { orderid: '1', amount: '2150', delivery_price: '150' } })?.goodsKop).toBe(200000)
  })
  it('без номера заказа — не заказ', () => {
    expect(tildaOrder({ Phone: '1' })).toBeNull()
  })
})

describe('parseParcel', () => {
  it('стороны по убыванию, вес необязателен', () => {
    expect(parseParcel('90×300×150 мм')).toEqual({ length_mm: 300, width_mm: 150, height_mm: 90, weight_g: null })
  })
  it('пусто и мусор — null', () => {
    expect(parseParcel('')).toBeNull()
    expect(parseParcel('габариты не заполнены')).toBeNull()
  })
})

describe('пункт в любом поле', () => {
  it('во вложенном поле оплаты', () => {
    expect(pvzOf({ payment: { delivery: 'Доставка до ПВЗ', delivery_pickup_name: 'Ozon 16703, ул. Красная, 1' } })).toBe(16703)
  })
  it('структура без значений', () => {
    expect(shapeOf({ Phone: '+79991234567', payment: { products: [{ name: 'Свеча' }], delivery: 'Ozon 1006, адрес' } }))
      .toEqual({ Phone: 'str12', payment: { products: [{ name: 'str5' }], delivery: 'str:ozon' } })
  })
})

describe('maskPersonal', () => {
  it('скрывает данные покупателя, оставляет заказ и пункт Ozon', () => {
    const body = {
      Name: 'Анна', Phone: '+7 (999) 123-45-67', Email: 'anna@mail.ru', formname: 'Cart', tranid: '8813:1234567890',
      Comments: 'позвонить 89991234567', ozon_pickup_point: 'Ozon 16703, Краснодар, ул. Красная, 1',
      payment: { ...payment, delivery_fio: 'Анна Петрова', delivery_address: 'Москва, ул. Ленина, 5, кв. 3' },
      note: 'пишите на a@b.ru или +7 999 111 22 33',
    }
    const m = maskPersonal(body) as Record<string, any>
    expect(m).toMatchObject({
      Name: '***', Phone: '***', Email: '***', formname: 'Cart', tranid: '8813:1234567890', Comments: '***',
      ozon_pickup_point: 'Ozon 16703, Краснодар, ул. Красная, 1', note: 'пишите на *** или ***',
    })
    expect(m.payment).toMatchObject({
      orderid: '1234567890', delivery: payment.delivery, delivery_fio: '***', delivery_address: '***',
      products: [{ name: 'Свеча «Ночной жасмин»', quantity: 2, amount: 3600 }],
    })
    expect(JSON.stringify(m)).not.toMatch(/Анна|anna@|999/)
  })
})
