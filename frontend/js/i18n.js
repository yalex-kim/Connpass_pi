/* =========================================================
   Connpass — i18n.js
   다국어 지원 (KO / EN / ZH)
   - locale JSON 파일을 fetch로 로드
   - t(key, vars?) : 현재 언어 번역 문자열 반환
   - setLang(lang) : 언어 전환 + localStorage 저장 + DOM 갱신
   - applyI18n()   : data-i18n 속성 기반 DOM 일괄 갱신
   ========================================================= */

'use strict';

(function () {
  const SUPPORTED = ['ko', 'en', 'zh'];
  const LOCALE_PATH = '/locales/';

  const _locales = {};
  let _lang = localStorage.getItem('ui-lang') || 'ko';
  if (!SUPPORTED.includes(_lang)) _lang = 'ko';

  // ── 번역 문자열 반환 ─────────────────────────────────────
  // vars: { n: 3, name: 'foo', ... } → "{n}개" → "3개"
  window.t = function (key, vars) {
    const locale = _locales[_lang] || _locales['ko'] || {};
    let val = locale[key] !== undefined ? locale[key]
      : (_locales['ko']?.[key] !== undefined ? _locales['ko'][key] : key);

    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach(function (k) {
        val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
      });
    }
    return val;
  };

  // ── 현재 언어 반환 ───────────────────────────────────────
  window.getCurrentLang = function () { return _lang; };

  // ── 언어 전환 ────────────────────────────────────────────
  window.setLang = function (lang) {
    if (!SUPPORTED.includes(lang) || !_locales[lang]) return;
    _lang = lang;
    localStorage.setItem('ui-lang', lang);

    // html lang 속성
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;

    // 상단 언어 버튼 active 상태 갱신
    document.querySelectorAll('.lang-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    window.applyI18n();

    // app.js의 applyLang()도 호출 (quick prompt, placeholder 등 동적 갱신)
    if (typeof window.applyLang === 'function') window.applyLang();
  };

  // ── data-i18n 속성 기반 DOM 일괄 갱신 ───────────────────
  window.applyI18n = function () {
    // 텍스트 내용 (innerHTML로 적용 — <br>, <code> 등 허용)
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.innerHTML = window.t(el.dataset.i18n);
    });
    // placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = window.t(el.dataset.i18nPlaceholder);
    });
    // title (tooltip)
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = window.t(el.dataset.i18nTitle);
    });
  };

  // ── locale JSON 로드 ─────────────────────────────────────
  window.i18nReady = Promise.all(
    SUPPORTED.map(function (lang) {
      return fetch(LOCALE_PATH + lang + '.json')
        .then(function (r) {
          if (!r.ok) throw new Error('Failed to load locale: ' + lang);
          return r.json();
        })
        .then(function (data) { _locales[lang] = data; })
        .catch(function (e) {
          console.warn('[i18n]', e.message);
          if (lang === 'ko') _locales['ko'] = {};
        });
    })
  ).then(function () {
    document.documentElement.lang = _lang === 'zh' ? 'zh-CN' : _lang;
    window.applyI18n();
  });
})();
