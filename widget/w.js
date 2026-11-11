/* ===========================================================================
   Ozon доставка для Tilda — виджет корзины.
   Подключение: <script src="https://<адрес сервера>/ozon-tilda/w.js" data-shop="sh_…" async></script>
   Готовую строку печатает команда ozon-tilda setup.

   Что делает:
   1. Ждёт блок доставки корзины Tilda (#customdelivery).
   2. Находит вариант доставки, в названии которого есть «Ozon».
   3. Пока выбран этот вариант — показывает поиск пункта выдачи по городу из поля Tilda.
   4. После выбора пункта спрашивает цену и ставит её в вариант штатным способом Tilda;
      пункт пишет в штатные поля доставки (pickup-id / pickup-address / pickup-name).
   5. Без выбранного пункта и цены заказ с Ozon не отправится.

   На сервер уходят ключ магазина, город, строка поиска, ID пункта и сумма корзины.
   Имя и email покупателя виджет не читает. Номер телефона — только если магазин подключил
   свои ключи Ozon: тогда виджет отправляет его (в теле POST, не в адресе) на проверку,
   есть ли на этот номер аккаунт Ozon, и без аккаунта не даёт оформить заказ с Ozon.

   Учтены «дёрганье» итогов корзины и наблюдатель на setTimeout вместо rAF.
   =========================================================================== */
(function () {
  'use strict';
  if (window.__cfOzonWidget) return;
  window.__cfOzonWidget = true;

  var API = '__API_BASE__';
  var script = document.currentScript || (function () {
    var s = document.querySelectorAll('script[data-shop]');
    return s[s.length - 1];
  })();
  var SHOP = script && script.getAttribute('data-shop');
  if (!SHOP) { console.error('[ozon-tilda] нет атрибута data-shop у скрипта'); return; }

  var VARIANT_RE = /ozon|озон/i;
  var LABEL_PREFIX = 'Ozon ';
  var CFG = { freeFromRub: null, fallbackRub: null, ready: true, checkPhone: false, badge: true };

  function get(path, params) {
    var qs = 'k=' + encodeURIComponent(SHOP);
    for (var k in params) if (params[k] !== undefined && params[k] !== null) qs += '&' + k + '=' + encodeURIComponent(params[k]);
    return fetch(API + path + '?' + qs, { credentials: 'omit' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d.__status = r.status; return d; });
    });
  }

  function post(path, data) {
    // text/plain — «простой» запрос без preflight; номер не попадает в адрес запроса.
    return fetch(API + path + '?k=' + encodeURIComponent(SHOP), {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(data)
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  // Режим корзины на сайте — для ozon-tilda show (раз за загрузку страницы на каждый вариант).
  var reported = {};
  function report(mode, issue) {
    var key = mode + '|' + (issue || '');
    if (reported[key]) return;
    reported[key] = true;
    get('/status', { mode: mode, issue: issue || null }).then(null, function () {});
  }

  function norm(s) { return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setDisplay(el, v) { if (el && el.style.display !== v) el.style.display = v; }
  function rub(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }

  /* --- стили: только запасные, основное снимаем с полей Tilda --- */
  var CSS = '\
.cfo{margin:16px 0 4px}.cfo,.cfo div,.cfo span{font-family:inherit}\
.cfo__label{font-size:14px;color:#7a7a7a;margin-bottom:6px}\
.cfo__box{position:relative}\
.cfo__input{width:100%;box-sizing:border-box;height:46px;padding:0 14px;border:1px solid #e0e0e0;border-radius:4px;font-size:15px;background:#fff;outline:none}\
.cfo__input[disabled]{background:#f6f6f6;color:#999;cursor:not-allowed}\
.cfo__list{position:absolute;z-index:50;left:0;right:0;top:calc(100% + 2px);background:#fff;border:1px solid #e0e0e0;border-radius:4px;box-shadow:0 6px 20px rgba(0,0,0,.12);max-height:280px;overflow-y:auto;display:none}\
.cfo__list.is-open{display:block}\
.cfo__item{padding:10px 14px;cursor:pointer;border-bottom:1px solid #f2f2f2}.cfo__item:last-child{border-bottom:0}\
.cfo__item:hover{background:#f5f5f5}\
.cfo__item-name{font-size:14px;color:#000}.cfo__item-addr{font-size:13px;color:#777;margin-top:2px}\
.cfo__empty{padding:12px 14px;font-size:14px;color:#777}\
.cfo__retry{cursor:pointer;text-decoration:underline}\
.cfo__card{margin-top:10px;border:1px solid #e0e0e0;border-radius:4px;padding:12px 14px;background:#fafafa}\
.cfo__card-name{font-size:14px;font-weight:600}.cfo__card-addr,.cfo__card-meta{font-size:13px;color:#666;margin-top:3px}\
.cfo__change{display:inline-block;margin-top:8px;font-size:13px;cursor:pointer;text-decoration:underline}\
.cfo__err{display:none;margin-top:6px;font-size:13px;color:#d0021b}.cfo__err.is-shown{display:block}\
.cfo__price{margin-top:8px;font-size:14px;color:#000}.cfo__price.is-muted{color:#777}.cfo__price.is-bad{color:#d0021b}\
.cfo__hint{margin-top:6px;font-size:12px;color:#888}.cfo__hint a{color:inherit}\
.cfo-tag{margin-left:6px;font-size:.85em;white-space:normal}.cfo-tag.is-ok{color:#1a7f37}.cfo-tag.is-bad{color:#d0021b}\
.cfo-off{opacity:.55;cursor:not-allowed}\
.cfo__phone{display:none;margin-top:8px;font-size:13px}.cfo__phone.is-ok{display:block;color:#1a7f37}.cfo__phone.is-bad{display:block;color:#d0021b}\
.cfo-badge{display:inline-block;vertical-align:middle;width:24px;height:24px;margin:-2px 0 0 8px}\
';
  function injectCSS() {
    if (document.getElementById('cfo-css')) return;
    var s = document.createElement('style'); s.id = 'cfo-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  var INPUT_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'height', 'paddingLeft', 'paddingRight',
    'borderRadius', 'backgroundColor', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderRightWidth', 'borderRightStyle',
    'borderRightColor', 'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor', 'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor'];
  var LABEL_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color'];
  var GROUP_PROPS = ['width', 'boxSizing', 'flexBasis', 'flexGrow', 'flexShrink', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingLeft', 'paddingRight'];

  function copyStyles(target, donor, props) {
    if (!target || !donor) return;
    var cs = getComputedStyle(donor);
    props.forEach(function (p) { if (target.style[p] !== cs[p]) target.style[p] = cs[p]; });
  }
  function fioInput(scope) { return scope.querySelector('[name="tildadelivery-userinitials"]'); }
  function styleFromDonor(wrap, scope) {
    var donor = fioInput(scope) || scope.querySelector('.t-input') || document.querySelector('.t706 .t-input');
    if (!donor) return;
    copyStyles(wrap.querySelector('.cfo__input'), donor, INPUT_PROPS);
    var cs = getComputedStyle(donor);
    if (wrap.style.fontFamily !== cs.fontFamily) wrap.style.fontFamily = cs.fontFamily;
    var group = donor.closest('.t-input-group');
    copyStyles(wrap.querySelector('.cfo__label'), group && group.querySelector('.t-input-title'), LABEL_PROPS);
    copyStyles(wrap, group, GROUP_PROPS);
  }

  /* --- вариант Ozon в корзине --- */
  function radios(scope) { return scope.querySelectorAll('[name="tildadelivery-type"]'); }
  function radioText(r) {
    var label = r.closest('label') || r.parentElement;
    return (label && label.textContent) || r.value || '';
  }
  function ozonRadio(scope) {
    var list = radios(scope);
    for (var i = 0; i < list.length; i++) if (VARIANT_RE.test(radioText(list[i]))) return list[i];
    return null;
  }
  function isOzonSelected(scope) {
    var r = scope.querySelector('[name="tildadelivery-type"]:checked');
    return !!r && VARIANT_RE.test(radioText(r));
  }
  function serviceId(scope) { var r = ozonRadio(scope); return r && r.getAttribute('data-service-id'); }

  function place(scope, wrap) {
    var fio = fioInput(scope);
    var group = fio && fio.closest('.t-input-group');
    if (group && group.parentElement) {
      if (wrap.nextElementSibling !== group) group.parentElement.insertBefore(wrap, group);
      return;
    }
    var list = radios(scope);
    var anchor = list.length ? list[list.length - 1] : null;
    while (anchor && anchor.parentElement && anchor.parentElement !== scope) anchor = anchor.parentElement;
    if (anchor && anchor.parentElement === scope) {
      if (wrap.previousElementSibling !== anchor) scope.insertBefore(wrap, anchor.nextSibling);
    } else if (wrap.parentElement !== scope) scope.appendChild(wrap);
  }

  /* --- запись в штатные поля доставки Tilda --- */
  function t706() { return document.querySelector('.t706') || document; }
  function claimPickupCarriers(holder, nameInput) {
    var root = t706();
    Array.prototype.forEach.call(root.querySelectorAll('[data-pickup-id],[data-pickup-address]'), function (el) {
      if (el === holder) return;
      el.removeAttribute('data-pickup-id'); el.removeAttribute('data-pickup-address');
    });
    Array.prototype.forEach.call(root.querySelectorAll('[name="tildadelivery-pickup-name"]'), function (el) {
      if (el !== nameInput && el.parentNode) el.parentNode.removeChild(el);
    });
  }
  function pickupLabel(p) {
    var tail = String(p.address || p.name || '').replace(/^\s*ozon\s*,?\s*/i, '').trim();
    return LABEL_PREFIX + p.id + (tail ? ', ' + tail : '');
  }
  function pushToCart() {
    try {
      if (window.tcart_newDelivery) window.tcart_newDelivery.saveTcartDelivery();
      if (typeof window.tcart__updateDelivery === 'function') window.tcart__updateDelivery();
    } catch (e) { console.error('[ozon-tilda] не удалось обновить корзину', e); }
  }
  function writePickup(holder, nameInput, p) {
    claimPickupCarriers(holder, nameInput);
    holder.setAttribute('data-pickup-id', p.id);
    holder.setAttribute('data-pickup-address', p.address);
    nameInput.value = pickupLabel(p);
    pushToCart();
  }
  function hasOurPickup(holder, nameInput) {
    if (holder.hasAttribute('data-pickup-id') || holder.hasAttribute('data-pickup-address')) return true;
    if (nameInput && nameInput.value) return true;
    var d = window.tcart && window.tcart.delivery;
    return !!(d && /^Ozon \d+/.test(String(d['pickup-name'] || '')));
  }
  function erasePickup(holder, nameInput) {
    if (!hasOurPickup(holder, nameInput)) return; // иначе перерисовка итогов → наблюдатель → цикл
    holder.removeAttribute('data-pickup-id'); holder.removeAttribute('data-pickup-address');
    if (nameInput) nameInput.value = '';
    var d = window.tcart && window.tcart.delivery;
    if (d) { delete d['pickup-id']; delete d['pickup-address']; d['pickup-name'] = ''; }
    pushToCart();
  }

  function goodsRub() {
    var t = window.tcart || {};
    var v = parseFloat(t.prodamount || 0);
    return isFinite(v) ? v : 0;
  }
  /* Посылка по товарам корзины — для отправления в Ozon (поле ozon_parcel уходит с заказом).
     Габариты и вес — из каталога Tilda: pack_x/y/z в мм, pack_m в граммах. Один товар — его
     упаковка; несколько — коробка по сумме объёмов с запасом 15 %, не меньше самого крупного
     товара. У какого-то товара нет габаритов или веса — пусто: сервер возьмёт типовую коробку. */
  function parcelText() {
    var ps = (window.tcart && window.tcart.products) || [];
    var desc = function (a, b) { return b - a; };
    var vol = 0, maxS = [0, 0, 0], weight = 0, units = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i], q = parseInt(p.quantity, 10) || 1;
      var d = [+p.pack_x, +p.pack_y, +p.pack_z].sort(desc);
      if (!(d[2] > 0) || !(+p.pack_m > 0)) return '';
      for (var k = 0; k < 3; k++) if (d[k] > maxS[k]) maxS[k] = d[k];
      vol += d[0] * d[1] * d[2] * q; units += q;
      weight += +p.pack_m * q;
    }
    if (!units) return '';
    var box = maxS;
    if (units > 1) {
      var v = vol * 1.15, s = Math.pow(v, 1 / 3);
      var l = Math.max(maxS[0], s), w = Math.max(maxS[1], s);
      box = [l, w, Math.max(maxS[2], v / (l * w))];
    }
    box = box.map(function (x) { return Math.ceil(x / 10) * 10; }).sort(desc);
    return box.join('×') + ' мм, ' + Math.round(weight) + ' г';
  }
  function setOzonPrice(scope, rubValue) {
    var sid = serviceId(scope);
    var nd = window.tcart_newDelivery;
    try {
      if (nd && typeof nd.updatePriceValueInRadio === 'function' && sid) { nd.updatePriceValueInRadio(rubValue, sid); return; }
      var r = ozonRadio(scope);
      if (r) r.setAttribute('data-delivery-price', String(rubValue));
      if (typeof window.tcart__updateDelivery === 'function') window.tcart__updateDelivery();
    } catch (e) { console.error('[ozon-tilda] не удалось записать цену', e); }
  }
  function getCity(scope) { var el = scope.querySelector('[name="tildadelivery-city"]'); return el ? el.value.trim() : ''; }

  /* --- проверка номера покупателя (только с ключами Ozon магазина) ---
     Ozon выдаёт заказ только владельцу аккаунта Ozon на номер из заказа. Номер берём из
     поля телефона корзины Tilda; «нет аккаунта» блокирует оформление с Ozon. */
  var PHONE = { key: '', can: null, seq: 0, timer: null };
  var PHONE_SEL = 'input[name="phone"],input[name="Phone"],input[type="tel"]';
  function phoneDigits(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
    return d.length === 10 && d[0] === '9' ? d : '';
  }
  function phoneInputs() { return document.querySelectorAll('.t706 ' + PHONE_SEL.split(',').join(',.t706 ')); }
  function currentPhone() {
    var list = phoneInputs();
    for (var i = 0; i < list.length; i++) { var d = phoneDigits(list[i].value); if (d) return d; }
    return '';
  }
  function setText(el, cls, text) {
    if (el.className !== cls) el.className = cls;
    if (el.textContent !== text) el.textContent = text;
  }
  /** Все варианты доставки Ozon в корзине: штатный со словом Ozon и наш добавленный. */
  function ozonRadioList() {
    return Array.prototype.filter.call(document.querySelectorAll('.t706 input[type="radio"]'), function (r) {
      return r.classList.contains('cfo-radio') || (r.name === 'tildadelivery-type' && VARIANT_RE.test(radioText(r)));
    });
  }
  /* Пометка у названия варианта Ozon: «номер найден» или «недоступно». Без аккаунта вариант
     нельзя выбрать; если он уже выбран — остаётся выбранным, но заказ не отправится. */
  function renderPhoneDom() {
    Array.prototype.forEach.call(document.querySelectorAll('.cfo__phone'), function (el) {
      if (PHONE.can === false) setText(el, 'cfo__phone is-bad', 'На этот номер нет аккаунта Ozon — заказ не получится выдать. Зарегистрируйтесь в приложении Ozon на этот номер или укажите другой.');
      else setText(el, 'cfo__phone', '');
    });
    ozonRadioList().forEach(function (r) {
      var label = r.closest('label') || r.parentElement;
      if (!label) return;
      var tag = label.querySelector('.cfo-tag');
      if (PHONE.can === null) { if (tag) tag.parentNode.removeChild(tag); }
      else {
        if (!tag) { tag = document.createElement('span'); label.appendChild(tag); }
        if (PHONE.can) setText(tag, 'cfo-tag is-ok', '✓ номер найден в Ozon');
        else setText(tag, 'cfo-tag is-bad', '— недоступно: на этот номер нет аккаунта Ozon');
      }
      var off = PHONE.can === false && !r.checked;
      if (r.disabled !== off) r.disabled = off;
      if (label.classList.contains('cfo-off') !== off) label.classList.toggle('cfo-off', off);
    });
  }
  function renderPhone() { unobserve(); try { renderPhoneDom(); } finally { observe(); } }
  /* Значок Ozon после названия варианта. Tilda пересоздаёт варианты — ставим его на каждом монтировании. */
  function addBadges() {
    if (!CFG.badge) return;
    ozonRadioList().forEach(function (r) {
      var label = r.closest('label') || r.parentElement;
      if (!label || label.querySelector('.cfo-badge')) return;
      var img = document.createElement('img');
      img.className = 'cfo-badge';
      img.src = API.replace(/\/api\/w$/, '') + '/ozon-badge.webp';
      img.alt = '';
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      var text = label.querySelector('.delivery-checkbox-label');
      label.insertBefore(img, text ? text.nextSibling : label.querySelector('.cfo-tag'));
    });
  }
  function checkPhoneNow() {
    var d = currentPhone();
    if (d === PHONE.key) return;
    PHONE.key = d; PHONE.can = null; renderPhone();
    if (!d) return;
    var seq = ++PHONE.seq;
    post('/check-phone', { phone: '+7' + d }).then(function (r) {
      if (seq !== PHONE.seq) return;
      PHONE.can = r && typeof r.canDeliver === 'boolean' ? r.canDeliver : null; // ошибка — не мешаем заказу
      renderPhone();
    }, function () {});
  }
  function watchPhone() {
    function onEvt(e) {
      var t = e.target;
      if (!t || !t.matches || !t.matches(PHONE_SEL) || !t.closest('.t706')) return;
      clearTimeout(PHONE.timer); PHONE.timer = setTimeout(checkPhoneNow, 600);
    }
    document.addEventListener('input', onEvt, true);
    document.addEventListener('change', onEvt, true);
    document.addEventListener('blur', onEvt, true);
    // Выбрали другой вариант доставки — вариант Ozon без аккаунта становится недоступным.
    document.addEventListener('change', function (e) {
      if (e.target && e.target.type === 'radio' && e.target.closest && e.target.closest('.t706')) setTimeout(renderPhone, 0);
    }, true);
    setTimeout(checkPhoneNow, 0); // номер мог подставиться автозаполнением
  }
  function phoneBlocks() { return CFG.checkPhone && PHONE.can === false; }
  function focusPhone() {
    var list = phoneInputs();
    for (var i = 0; i < list.length; i++) if (list[i].type !== 'hidden') { try { list[i].focus(); } catch (e) {} return; }
  }
  function hintHTML() {
    var h = 'Для получения нужен аккаунт Ozon на номер телефона из заказа';
    if (CFG.checkPhone) {
      h += ' — мы проверим номер в Ozon';
    }
    return h + '. Оплата при получении недоступна.';
  }

  /* --- сам блок --- */
  /* ad — адаптер режима: куда писать цену и пункт (см. advancedAdapter и injectAdapter). */
  function build(scope, ad) {
    var form = ad.form;
    if (!form) return null;
    var wrap = document.createElement('div');
    wrap.className = 'cfo';
    wrap.style.paddingTop = '14px'; /* margin у .cfo в корзине Тильды не срабатывает — заголовок лип к вариантам доставки */
    wrap.innerHTML =
      '<div class="cfo__label">Пункт выдачи Ozon</div>' +
      '<div class="cfo__box"><input class="cfo__input" type="text" autocomplete="off" placeholder="Начните вводить улицу или ТЦ" aria-label="Пункт выдачи Ozon"><div class="cfo__list" role="listbox"></div></div>' +
      '<div class="cfo__err">Выберите пункт выдачи</div>' +
      '<input type="hidden" name="tildadelivery-pickup-name">' +
      '<input type="hidden" name="ozon_parcel">' +
      '<div class="cfo__card" style="display:none"><div class="cfo__card-name"></div><div class="cfo__card-addr"></div><div class="cfo__card-meta"></div>' +
      '<span class="cfo__change" role="button" tabindex="0">Выбрать другой пункт</span></div>' +
      '<div class="cfo__price" style="display:none"></div>' +
      '<div class="cfo__phone"></div>' +
      '<div class="cfo__hint">' + hintHTML() + '</div>';

    var input = wrap.querySelector('.cfo__input'), list = wrap.querySelector('.cfo__list'), err = wrap.querySelector('.cfo__err');
    var card = wrap.querySelector('.cfo__card'), box = wrap.querySelector('.cfo__box'), priceEl = wrap.querySelector('.cfo__price');
    var pickupName = wrap.querySelector('[name="tildadelivery-pickup-name"]');
    var state = { city: '', selected: null, seq: 0, quote: null, quoteKey: '', qseq: 0 };

    function showPrice(text, kind) {
      priceEl.className = 'cfo__price' + (kind ? ' is-' + kind : '');
      priceEl.textContent = text;
      setDisplay(priceEl, text ? '' : 'none');
    }
    function daysText(d) {
      if (!d) return '';
      var m10 = d % 10, m100 = d % 100;
      var w = (m10 === 1 && m100 !== 11) ? 'день' : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) ? 'дня' : 'дней';
      return ' · ' + d + ' ' + w;
    }
    function freeHint(price) {
      if (!CFG.freeFromRub || price === 0) return '';
      var left = CFG.freeFromRub - goodsRub();
      return left > 0 ? '. До бесплатной доставки осталось ' + rub(left) : '';
    }
    function currentKey() { return state.selected ? state.selected.id + '|' + Math.round(goodsRub()) : ''; }
    function resetQuote() { state.quote = null; state.quoteKey = ''; showPrice('', ''); }

    var parcel = wrap.querySelector('[name="ozon_parcel"]');
    function requote() {
      parcel.value = parcelText();
      if (!state.selected) { resetQuote(); return; }
      var key = currentKey();
      if (key === state.quoteKey && state.quote) return;
      state.quoteKey = key; state.quote = { pending: true };
      showPrice('Считаем стоимость доставки…', 'muted');
      var seq = ++state.qseq;
      get('/quote', { pvz: state.selected.id, goods: Math.round(goodsRub()) }).then(function (q) {
        if (seq !== state.qseq) return;
        state.quote = q;
        if (q && q.available) {
          ad.setPrice(q.priceRub);
          showPrice((q.free ? 'Доставка бесплатно' : 'Доставка ' + rub(q.priceRub)) + daysText(q.days) + freeHint(q.priceRub), '');
          err.classList.remove('is-shown');
        } else {
          showPrice((q && q.message) || 'Ozon не может доставить этот заказ', 'bad');
        }
      }, function () {
        if (seq !== state.qseq) return;
        // Сеть до нашего сервера: берём резервную цену магазина, если она есть.
        if (CFG.fallbackRub !== null) {
          state.quote = { available: true, priceRub: CFG.fallbackRub, fallback: true };
          ad.setPrice(CFG.fallbackRub);
          showPrice('Доставка ' + rub(CFG.fallbackRub), '');
        } else {
          state.quote = { available: false };
          showPrice('Не удалось рассчитать доставку, попробуйте ещё раз', 'bad');
        }
      });
    }
    var quoteTimer = null;
    function requoteDebounced() { clearTimeout(quoteTimer); quoteTimer = setTimeout(requote, 400); }
    function quotedPrice() { return state.quote && state.quote.available === true ? state.quote.priceRub : null; }
    function priceInCart() { return (parseFloat(ad.getPrice()) || 0) === quotedPrice(); }
    /* Tilda при любом изменении корзины пересоздаёт варианты доставки, и цена на радиокнопке
       обнуляется — иногда уже после нашего ответа о цене. Посчитанную цену возвращаем на место. */
    function restorePrice() {
      if (quotedPrice() !== null && state.quoteKey === currentKey() && !priceInCart()) ad.setPrice(quotedPrice());
    }

    function clearSelection() {
      state.selected = null; resetQuote();
      ad.erase(input, pickupName);
      setDisplay(card, 'none'); setDisplay(box, '');
      if (input.value !== '') input.value = '';
    }
    function select(p) {
      state.selected = p;
      ad.write(input, pickupName, p);
      card.querySelector('.cfo__card-name').textContent = p.name;
      card.querySelector('.cfo__card-addr').textContent = p.address;
      card.querySelector('.cfo__card-meta').textContent = p.hours || '';
      setDisplay(card, ''); setDisplay(box, 'none');
      list.classList.remove('is-open'); err.classList.remove('is-shown');
      requote();
    }
    function render(res, points) {
      if (!res) {
        list.innerHTML = '<div class="cfo__empty">Не удалось загрузить пункты выдачи. <span class="cfo__retry">Повторить</span></div>';
        list.querySelector('.cfo__retry').addEventListener('mousedown', function (e) { e.preventDefault(); query(); });
      } else if (!points.length) {
        list.innerHTML = '<div class="cfo__empty">' + (input.value ? 'Ничего не нашлось — попробуйте другую улицу' : 'В городе «' + esc(state.city) + '» пунктов выдачи Ozon не нашлось') + '</div>';
      } else {
        list.innerHTML = points.map(function (p) {
          return '<div class="cfo__item" role="option" data-id="' + esc(p.id) + '"><div class="cfo__item-name">' + esc(p.name) + '</div><div class="cfo__item-addr">' + esc(p.address) + '</div></div>';
        }).join('');
        Array.prototype.forEach.call(list.querySelectorAll('.cfo__item'), function (el) {
          el.addEventListener('mousedown', function (e) {
            e.preventDefault();
            var p = points.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
            if (p) select(p);
          });
        });
      }
      list.classList.add('is-open');
    }
    function query() {
      var seq = ++state.seq;
      get('/pvz', { city: state.city, q: input.value }).then(function (d) {
        if (seq !== state.seq) return;
        render(d.__status === 200, d.points || []);
      }, function () { if (seq === state.seq) render(false, []); });
    }
    var typeTimer = null;
    input.addEventListener('focus', query);
    input.addEventListener('input', function () { clearTimeout(typeTimer); typeTimer = setTimeout(query, 250); });
    input.addEventListener('blur', function () { setTimeout(function () { list.classList.remove('is-open'); }, 150); });
    var change = card.querySelector('.cfo__change');
    function onChange() { clearSelection(); input.focus(); }
    change.addEventListener('click', onChange);
    change.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(); } });

    if (PHONE.can !== null) setTimeout(renderPhone, 0);
    wrap.__api = {
      setCity: function (city) {
        if (norm(city) === norm(state.city)) return;
        state.city = city; clearSelection();
        input.disabled = !city;
        input.placeholder = city ? 'Начните вводить улицу или ТЦ' : 'Сначала укажите город';
      },
      isValid: function () { return !phoneBlocks() && !!state.selected && !!state.quote && state.quote.available === true && state.quoteKey === currentKey() && priceInCart(); },
      showError: function () {
        if (!state.selected) { err.classList.add('is-shown'); return; }
        if (!state.quote || state.quoteKey !== currentKey()) requote(); else restorePrice();
        if (phoneBlocks()) focusPhone();
      },
      requote: requoteDebounced,
      restorePrice: restorePrice,
      clearFields: clearSelection
    };
    return wrap;
  }

  /* --- режим 1: расширенная доставка Tilda (#customdelivery), вариант со словом Ozon --- */
  function advancedAdapter(scope) {
    return {
      form: scope.closest('form') || document.querySelector('.t706 form'),
      setPrice: function (r) { setOzonPrice(scope, r); },
      getPrice: function () { var r = ozonRadio(scope); return r && r.getAttribute('data-delivery-price'); },
      write: writePickup,
      erase: erasePickup
    };
  }

  /* --- режимы 2 и 3: свой блок «город + пункт» под вариантом Ozon ---
     Корзина Tilda берёт доставку из отмеченной радиокнопки внутри .t-radio__wrapper-delivery:
     название — из value (до «=»), цену — из data-delivery-price, пересчёт — tcart__updateDelivery().
     Номер и адрес пункта кладём в название: так они попадают в заказ, письмо и CRM.
     Режим 2 — в корзине нет доставки: добавляем группу «Доставка» с единственным вариантом Ozon.
     Режим 3 — обычный список (СДЭК, Почта…): добавляем вариант Ozon в него же (или берём
     существующий со словом Ozon), а город и пункт показываем, только когда выбран Ozon. */
  var INJECT_LABEL = 'Ozon, пункт выдачи';
  function cleanLabel(s) { return String(s).replace(/=/g, '-'); }

  function ownAdapter(radio, hidden, form) {
    var label = INJECT_LABEL;
    function apply(price) {
      radio.value = cleanLabel(label) + ' = ' + price;
      radio.setAttribute('data-delivery-price', String(price));
      if (!radio.checked) return;
      try { if (typeof window.tcart__updateDelivery === 'function') window.tcart__updateDelivery(); } catch (e) { console.error('[ozon-tilda]', e); }
    }
    return {
      form: form,
      setPrice: function (r) { apply(r); },
      getPrice: function () { return radio.getAttribute('data-delivery-price'); },
      write: function (_i, _n, p) { label = INJECT_LABEL + ': ' + pickupLabel(p); hidden.value = pickupLabel(p); apply(radio.getAttribute('data-delivery-price') || 0); },
      erase: function () { if (!hidden.value && label === INJECT_LABEL) return; label = INJECT_LABEL; hidden.value = ''; apply(0); }
    };
  }

  var CITY_HTML =
    '<input type="hidden" name="ozon_pickup_point">' +
    '<div class="cfo" style="margin-top:12px"><div class="cfo__label">Город</div>' +
      '<div class="cfo__box"><input class="cfo__input cfo-city" type="text" autocomplete="off" placeholder="Начните вводить город" aria-label="Город"><div class="cfo__list cfo-city-list" role="listbox"></div></div></div>';

  function radioHTML(name, checked) {
    return '<label class="t-radio__control t-text t-text_xs cfo-radio-label">' +
      '<input type="radio" class="t-radio t-radio_delivery js-tilda-rule cfo-radio" name="' + esc(name) + '" value="' + INJECT_LABEL + ' = 0" data-delivery-price="0"' + (checked ? ' checked' : '') + '>' +
      '<div class="t-radio__indicator"></div> ' + INJECT_LABEL + '</label>';
  }

  var ownGuards = []; // проверки режимов 2 и 3 для сторожа кнопки заказа: true — заказ не пускаем

  /** Город + пункт в block. radio — вариант Ozon; isActive — выбран ли он сейчас. */
  function setupOwn(block, form, radio, isActive) {
    var hidden = block.querySelector('[name="ozon_pickup_point"]');
    var wrap = build(block, ownAdapter(radio, hidden, form));
    if (!wrap) return null;
    block.appendChild(wrap);
    wrap.style.display = '';
    wrap.querySelector('.cfo__label').textContent = 'Пункт выдачи';
    var pvzInput = wrap.querySelector('.cfo__input');
    pvzInput.disabled = true;
    pvzInput.placeholder = 'Сначала выберите город';

    var cityInput = block.querySelector('.cfo-city'), cityList = block.querySelector('.cfo-city-list');
    var cseq = 0, ctimer = null;
    function pickCity(name) { cityInput.value = name; cityList.classList.remove('is-open'); wrap.__api.setCity(name); }
    function suggest() {
      var term = cityInput.value.trim();
      if (term.length < 2) { cityList.classList.remove('is-open'); return; }
      var seq = ++cseq;
      get('/cities', { q: term }).then(function (d) {
        if (seq !== cseq) return;
        var list = d.cities || [];
        cityList.innerHTML = list.length ? list.map(function (c) {
          return '<div class="cfo__item" role="option" data-city="' + esc(c.city) + '"><div class="cfo__item-name">' + esc(c.city) + '</div><div class="cfo__item-addr">пунктов выдачи: ' + c.points + '</div></div>';
        }).join('') : '<div class="cfo__empty">Город не найден среди пунктов Ozon</div>';
        Array.prototype.forEach.call(cityList.querySelectorAll('.cfo__item'), function (el) {
          el.addEventListener('mousedown', function (e) { e.preventDefault(); pickCity(el.getAttribute('data-city')); });
        });
        cityList.classList.add('is-open');
      });
    }
    cityInput.addEventListener('input', function () { clearTimeout(ctimer); ctimer = setTimeout(suggest, 250); if (!cityInput.value.trim()) wrap.__api.setCity(''); });
    cityInput.addEventListener('blur', function () { setTimeout(function () { cityList.classList.remove('is-open'); }, 150); });

    var donor = form.querySelector('.t-input');
    if (donor) { copyStyles(cityInput, donor, INPUT_PROPS); copyStyles(pvzInput, donor, INPUT_PROPS); block.style.fontFamily = getComputedStyle(donor).fontFamily; }
    var title = form.querySelector('.t-input-title');
    if (title) Array.prototype.forEach.call(block.querySelectorAll('.cfo__label, .t-input-title'), function (l) { copyStyles(l, title, LABEL_PROPS); });

    var lastGoods = goodsRub();
    setInterval(function () { var g = goodsRub(); if (g !== lastGoods) { lastGoods = g; if (isActive()) wrap.__api.requote(); } }, 1000);
    ownGuards.push(function () {
      if (!isActive() || wrap.__api.isValid()) return false;
      if (!cityInput.value.trim()) cityInput.focus();
      wrap.__api.showError();
      try { block.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (x) {}
      return true;
    });
    return wrap;
  }

  function mountOwn() {
    var form = document.querySelector('.t706 .t-form');
    if (!form || form.querySelector('.cfo-own')) return;
    if (document.querySelector('.t706 #customdelivery')) return; // режим 1
    injectCSS();
    var list = form.querySelector('.t-radio__wrapper-delivery');
    var block = document.createElement('div');
    block.className = 'cfo-own';
    var radio;

    if (!list) {
      // Режим 2: доставки в корзине нет.
      report('none');
      var box = form.querySelector('.t-form__inputsbox') || form;
      var groups = box.querySelectorAll('.t-input-group');
      var after = groups.length ? groups[groups.length - 1] : null;
      block.className = 't-input-group cfo-own';
      block.innerHTML = '<div class="t-input-title t-descr t-descr_md" style="margin-bottom:8px">Доставка</div>' +
        '<div class="t-radio__wrapper t-radio__wrapper-delivery">' + radioHTML('tildadelivery', true) + '</div>' + CITY_HTML;
      if (after && after.parentNode) after.parentNode.insertBefore(block, after.nextSibling); else box.appendChild(block);
      radio = block.querySelector('.cfo-radio');
      setupOwn(block, form, radio, function () { return true; });
      try { if (typeof window.tcart__updateDelivery === 'function') window.tcart__updateDelivery(); } catch (e) {}
      return;
    }

    // Режим 3: обычный список доставки магазина.
    report('simple');
    var existing = null;
    Array.prototype.forEach.call(list.querySelectorAll('input[type="radio"]'), function (r) { if (!existing && VARIANT_RE.test(r.value || radioText(r))) existing = r; });
    if (existing) {
      radio = existing;
      radio.classList.add('cfo-radio');
    } else {
      var sample = list.querySelector('input[type="radio"]');
      var tmp = document.createElement('div');
      tmp.innerHTML = radioHTML(sample ? sample.name : 'Delivery', false);
      var lbl = tmp.firstChild;
      var sampleLabel = sample && sample.closest('label');
      if (sampleLabel) lbl.className = sampleLabel.className + ' cfo-radio-label';
      list.appendChild(lbl);
      radio = lbl.querySelector('input');
    }
    var group = list.closest('.t-input-group') || list.parentNode;
    block.innerHTML = CITY_HTML;
    group.parentNode.insertBefore(block, group.nextSibling);
    var isActive = function () { return radio.checked; };
    var wrap = setupOwn(block, form, radio, isActive);
    function toggle() {
      setDisplay(block, radio.checked ? '' : 'none');
      if (radio.checked && wrap) wrap.__api.requote();
    }
    Array.prototype.forEach.call(list.querySelectorAll('input[type="radio"]'), function (r) {
      r.addEventListener('change', function () {
        toggle();
        try { if (typeof window.tcart__updateDelivery === 'function') window.tcart__updateDelivery(); } catch (e) {}
      });
    });
    toggle();
  }

  function sync(scope) {
    var wrap = scope.querySelector('.cfo');
    if (!wrap) return;
    var on = isOzonSelected(scope);
    setDisplay(wrap, on ? '' : 'none');
    if (!on) { wrap.__api.clearFields(); return; }
    wrap.__api.setCity(getCity(scope));
    wrap.__api.restorePrice();
  }

  var warned = false;
  function mount() {
    mountOwn();
    if (CFG.checkPhone) setTimeout(renderPhone, 0); // Tilda могла перерисовать варианты доставки
    Array.prototype.forEach.call(document.querySelectorAll('#customdelivery'), function (scope) {
      if (scope.closest('.cfo-own')) return;
      if (!ozonRadio(scope)) {
        if (radios(scope).length) report('advanced', 'advanced_no_ozon');
        if (!warned && radios(scope).length) {
          warned = true;
          console.warn('[ozon-tilda] в корзине нет способа доставки со словом «Ozon» в названии — добавьте его в настройках корзины Tilda');
        }
        return;
      }
      report('advanced');
      injectCSS();
      var wrap = scope.querySelector('.cfo');
      if (wrap && (!wrap.__api || !wrap.querySelector('.cfo__input'))) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); wrap = null; }
      if (!wrap) {
        wrap = build(scope, advancedAdapter(scope));
        if (!wrap) return;
        if (!scope.__cfoChange) {
          scope.__cfoChange = true;
          scope.addEventListener('change', function (e) {
            if (e.target && /^tildadelivery-(type|city)$/.test(e.target.name || '')) setTimeout(function () { sync(scope); }, 50);
          }, true);
        }
        var form = scope.closest('form') || document.querySelector('.t706 form');
        if (form && !form.__cfoGuard) {
          form.__cfoGuard = true;
          var lastGoods = goodsRub();
          setInterval(function () {
            var g = goodsRub();
            if (g === lastGoods) return;
            lastGoods = g;
            var w = scope.querySelector('.cfo');
            if (w && w.__api && isOzonSelected(scope)) w.__api.requote();
          }, 1000);
        }
      }
      place(scope, wrap);
      styleFromDonor(wrap, scope);
      sync(scope);
    });
    addBadges();
  }

  /* --- сторож кнопки заказа ---
     Tilda оформляет заказ из обработчика клика по кнопке, а submit приходит только на Enter,
     и в ответ она сама жмёт кнопку. Поэтому ловим и клик, и submit на window в фазе захвата —
     раньше обработчиков Tilda. Ozon выбран, а виджет не смонтировался — тоже не пускаем. */
  function advancedBlocks(form) {
    var scope = form.querySelector('#customdelivery') || document.querySelector('.t706 #customdelivery');
    if (!scope || !isOzonSelected(scope)) return false;
    var w = scope.querySelector('.cfo');
    if (w && w.__api && w.__api.isValid()) return false;
    if (w && w.__api) {
      w.__api.showError();
      try { w.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (x) {}
    } else schedule();
    return true;
  }
  function guardOrder(e) {
    var t = e.target;
    var form = e.type === 'submit' ? t : (t && t.closest && t.closest('[type="submit"]') && t.closest('.t706 form'));
    if (!form || !form.closest || !form.closest('.t706')) return;
    var blocked = advancedBlocks(form);
    for (var i = 0; i < ownGuards.length && !blocked; i++) blocked = ownGuards[i]();
    if (!blocked) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function guardOrders() {
    window.addEventListener('click', guardOrder, true);
    window.addEventListener('submit', guardOrder, true);
  }

  function isOwn(el) { return !!(el && el.closest && el.closest('.cfo')); }
  function touchesDelivery(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.id === 'customdelivery' || !!(node.querySelector && node.querySelector('#customdelivery'));
  }
  function isRelevant(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var t = r.target && r.target.nodeType === 1 ? r.target : (r.target && r.target.parentElement);
      if (t && !isOwn(t) && t.closest && t.closest('#customdelivery')) return true;
      var nodes = Array.prototype.slice.call(r.addedNodes).concat(Array.prototype.slice.call(r.removedNodes));
      for (var j = 0; j < nodes.length; j++) if (touchesDelivery(nodes[j])) return true;
    }
    return false;
  }
  var mo = new MutationObserver(function (records) { if (isRelevant(records)) schedule(); });
  var scheduled = false;
  function observe() { mo.observe(document.body, { childList: true, subtree: true }); }
  function unobserve() { mo.disconnect(); mo.takeRecords(); }
  function safeMount() { unobserve(); try { mount(); } catch (e) { console.error('[ozon-tilda]', e); } observe(); }
  // setTimeout, не requestAnimationFrame: rAF не вызывается в скрытой вкладке, и наблюдатель «умирал».
  function schedule() { if (scheduled) return; scheduled = true; setTimeout(function () { scheduled = false; safeMount(); }, 0); }

  function start() {
    get('/config', {}).then(function (c) {
      if (c.__status === 403 && c.error === 'domain_not_allowed') {
        console.error('[ozon-tilda] домен ' + c.domain + ' не разрешён для этого магазина');
        return;
      }
      if (c.__status !== 200) { console.error('[ozon-tilda] магазин не найден, проверьте data-shop'); return; }
      CFG.freeFromRub = c.freeFromRub; CFG.fallbackRub = c.fallbackRub; CFG.ready = c.ready;
      CFG.checkPhone = c.checkPhone === true;
      CFG.badge = c.badge !== false;
      guardOrders();
      safeMount();
      if (CFG.checkPhone) watchPhone();
    }, function () { guardOrders(); safeMount(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
