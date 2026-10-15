// Витрина «Квал. сделки месяца» на рабочем столе amoCRM (Капиталстрой).
// Виджет только встраивает страницу витрины (GitHub Pages) блоком над рабочим столом, в CRM ничего не пишет.
define(['jquery'], function ($) {
  var URL = 'https://33shumm-beep.github.io/Poshumim/sdelki/?embed=1#k=lBUITowtgg3wJMK61bcw';
  var ID = 'ks-vitrina-sdelok';

  function naStole() { return /^\/dashboard/.test(location.pathname); }

  function vstavit() {
    var est = document.getElementById(ID);
    if (!naStole()) { if (est) est.parentNode.removeChild(est); return; }
    if (est) return;
    var kuda = $('#work_area').first();
    if (!kuda.length) kuda = $('#page_holder').first();
    if (!kuda.length) return;
    var svernut = localStorage.getItem(ID + ':svernut') === '1';
    var blok = $(
      '<div id="' + ID + '" style="margin:12px 16px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.15);overflow:hidden;position:relative;z-index:2">' +
        '<div class="ks-shapka" style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;cursor:pointer;font:600 14px/1.3 Arial,sans-serif;color:#2e3640;border-bottom:1px solid #e5e8ec">' +
          '<span>Квал. сделки месяца</span><span class="ks-strelka">' + (svernut ? '▸' : '▾') + '</span>' +
        '</div>' +
        '<iframe src="' + URL + '" style="display:' + (svernut ? 'none' : 'block') + ';width:100%;height:640px;border:0" loading="lazy"></iframe>' +
      '</div>'
    );
    blok.find('.ks-shapka').on('click', function () {
      var fr = blok.find('iframe'), skryt = fr.is(':visible');
      fr.toggle(!skryt);
      blok.find('.ks-strelka').text(skryt ? '▸' : '▾');
      try { localStorage.setItem(ID + ':svernut', skryt ? '1' : '0'); } catch (e) {}
    });
    kuda.prepend(blok);
  }

  return function () {
    var self = this;
    this.callbacks = {
      render: function () { vstavit(); return true; },
      init: function () {
        // amoCRM — одностраничное приложение: следим за переходами на рабочий стол и обратно.
        if (!window.__ksVitrinaTimer) window.__ksVitrinaTimer = setInterval(vstavit, 1500);
        return true;
      },
      bind_actions: function () { return true; },
      settings: function () { return true; },
      onSave: function () { return true; },
      destroy: function () {}
    };
    return this;
  };
});
