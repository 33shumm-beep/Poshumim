/**
 * Shumm — связь с AmoCRM без отдельных сервисов.
 *
 * Скрипт живёт внутри Google и делает три вещи:
 *   1. Отдаёт приложению Shumm готовые цифры по адресу веб-приложения.
 *   2. Заполняет ежедневный отчёт в таблице в 8:30 по Москве.
 *   3. Присылает утреннюю сводку в Telegram в 9:00.
 *
 * Настраивается один раз: заполните НАСТРОЙКИ ниже и запустите функцию
 * включитьРасписание. Всё остальное произойдёт само.
 */

var НАСТРОЙКИ = {
  // Токен AmoCRM. Вставьте между кавычками.
  токен: 'ВСТАВЬТЕ_ТОКЕН_СЮДА',

  // Адрес аккаунта без .amocrm.ru
  поддомен: 'macridin',

  // Ключ, который защищает адрес от посторонних. Придумайте любой набор букв.
  ключ: 'shumm-8f3a21',

  планМесяца: 17000000,
  цельКонверсии: 80,
  срокЦели: '18 ноября',

  // Таблица отчёта: идентификатор из её адреса и номер листа после gid=
  таблицаId: '1shynPgH8zuxJV1U9VGeTmPVxgll32nG-',
  листGid: 1888872931,

  // Telegram. Номер чата оставьте пустым: скрипт найдёт его сам,
  // как только вы напишете боту любое сообщение.
  telegramТокен: 'ВСТАВЬТЕ_ТОКЕН_БОТА',
  telegramЧат: ''
};

var ВЫИГРАНА = 142, ПРОИГРАНА = 143;

/* ====================== адрес для приложения ====================== */

function doGet(e) {
  var параметры = (e && e.parameter) || {};
  var ответ;

  if (параметры.key !== НАСТРОЙКИ.ключ) {
    ответ = { error: 'Неверный ключ' };
  } else {
    try {
      ответ = собратьЦифры();
    } catch (err) {
      ответ = { error: String(err && err.message ? err.message : err) };
    }
  }

  var текст = JSON.stringify(ответ);

  // Если браузер просит через callback, отвечаем в формате JSONP:
  // так запрос проходит даже при строгих настройках безопасности.
  if (параметры.callback) {
    return ContentService
      .createTextOutput(параметры.callback + '(' + текст + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(текст).setMimeType(ContentService.MimeType.JSON);
}

/* ====================== работа с AmoCRM ====================== */

function запросAmo_(путь, параметры) {
  var адрес = 'https://' + НАСТРОЙКИ.поддомен + '.amocrm.ru/api/v4/' + путь;
  if (параметры) {
    var части = [];
    for (var ключ in параметры) части.push(encodeURIComponent(ключ) + '=' + encodeURIComponent(параметры[ключ]));
    if (части.length) адрес += '?' + части.join('&');
  }
  var ответ = UrlFetchApp.fetch(адрес, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + НАСТРОЙКИ.токен },
    muteHttpExceptions: true
  });
  var код = ответ.getResponseCode();
  if (код === 204) return {};
  if (код === 401) throw new Error('AmoCRM не принял токен. Проверьте, что он вставлен целиком.');
  if (код >= 400) throw new Error('AmoCRM ответил ошибкой ' + код + ' на запросе ' + путь);
  return JSON.parse(ответ.getContentText() || '{}');
}

function собратьЦифры() {
  var начало = new Date();
  начало = Math.floor(new Date(начало.getFullYear(), начало.getMonth(), 1).getTime() / 1000);

  var воронки = (запросAmo_('leads/pipelines')._embedded || {}).pipelines || [];
  var сделки = (запросAmo_('leads', { limit: 250, 'filter[created_at][from]': начало })._embedded || {}).leads || [];
  var люди = (запросAmo_('users')._embedded || {}).users || [];

  // Все этапы всех воронок: номер этапа -> порядок, воронка, название
  var этапы = {}, справочник = [];
  воронки.forEach(function (в) {
    var список = (в._embedded || {}).statuses || [];
    справочник.push({
      воронка: в.name,
      id: в.id,
      этапы: список.map(function (с) { return { id: с.id, название: с.name, порядок: с.sort }; })
    });
    список.forEach(function (с) { этапы[с.id] = { порядок: с.sort, воронка: в.id, название: с.name }; });
  });

  // Этапы ищем по названию, чтобы не спрашивать номера у человека.
  function найти(шаблон) {
    var найденные = [];
    for (var id in этапы) if (шаблон.test(этапы[id].название)) найденные.push({ id: +id, порядок: этапы[id].порядок, воронка: этапы[id].воронка });
    return найденные;
  }
  var этапКвал = найти(/квал/i), этапЗамер = найти(/замер/i);

  var замечания = [];
  if (!этапКвал.length) замечания.push('не найден этап со словом «квал»');
  if (!этапЗамер.length) замечания.push('не найден этап со словом «замер»');

  function дошла(сделка, список) {
    if (сделка.status_id === ВЫИГРАНА) return true;
    if (сделка.status_id === ПРОИГРАНА) return false;
    var текущий = этапы[сделка.status_id];
    if (!текущий) return false;
    var свои = список.filter(function (э) { return э.воронка === текущий.воронка; });
    if (!свои.length) return false;
    var порог = Math.min.apply(null, свои.map(function (э) { return э.порядок; }));
    return текущий.порядок >= порог;
  }

  var живые = сделки.filter(function (с) { return с.status_id !== ПРОИГРАНА; });
  var квалы = этапКвал.length ? живые.filter(function (с) { return дошла(с, этапКвал); }).length : живые.length;
  var замеры = этапЗамер.length ? живые.filter(function (с) { return дошла(с, этапЗамер); }).length : 0;
  var договоры = сделки.filter(function (с) { return с.status_id === ВЫИГРАНА; }).length;
  var сумма = сделки.reduce(function (и, с) { return с.status_id === ВЫИГРАНА ? и + (с.price || 0) : и; }, 0);

  var поЛюдям = {};
  живые.forEach(function (с) {
    var id = с.responsible_user_id;
    поЛюдям[id] = поЛюдям[id] || { всего: 0, выиграно: 0 };
    поЛюдям[id].всего++;
    if (с.status_id === ВЫИГРАНА) поЛюдям[id].выиграно++;
  });
  function инициалы(имя) {
    return String(имя || '').split(' ').filter(String).slice(0, 2)
      .map(function (ч) { return ч.charAt(0).toUpperCase() + '.'; }).join(' ');
  }
  var менеджеры = люди.filter(function (ч) { return поЛюдям[ч.id]; }).map(function (ч) {
    var s = поЛюдям[ч.id];
    return { name: инициалы(ч.name), area: '', pct: Math.round(s.выиграно / s.всего * 100) };
  }).sort(function (a, b) { return b.pct - a.pct; });

  var сейчас = Math.floor(Date.now() / 1000), ЧАС = 3600;
  var проблемы = живые.filter(function (с) {
    return с.status_id !== ВЫИГРАНА && сейчас - (с.updated_at || с.created_at || сейчас) > 48 * ЧАС;
  }).sort(function (a, b) { return (a.updated_at || 0) - (b.updated_at || 0); }).slice(0, 5).map(function (с) {
    return {
      id: String(с.id),
      title: с.name || ('Сделка №' + с.id),
      note: 'без касания, ' + ((этапы[с.status_id] || {}).название || 'этап неизвестен'),
      age: Math.round((сейчас - (с.updated_at || сейчас)) / ЧАС) + ' ч',
      level: 'bad'
    };
  });

  return {
    updated: new Date().toISOString(),
    plan: { target: НАСТРОЙКИ.планМесяца, done: сумма },
    conversion: {
      current: квалы ? Math.round(замеры / квалы * 100) : 0,
      goal: НАСТРОЙКИ.цельКонверсии,
      deadline: НАСТРОЙКИ.срокЦели,
      history: историяКонверсии_(квалы ? Math.round(замеры / квалы * 100) : 0)
    },
    funnel: { quals: квалы, measures: замеры, contracts: договоры },
    managers: менеджеры,
    problems: проблемы,
    warnings: замечания,
    _ref: справочник
  };
}

/** Копит конверсию по дням, чтобы на графике была динамика, а не одна точка. */
function историяКонверсии_(текущая) {
  var хранилище = PropertiesService.getScriptProperties();
  var сырое = хранилище.getProperty('история');
  var история = сырое ? JSON.parse(сырое) : [];
  var сегодня = Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd');
  if (!история.length || история[история.length - 1].d !== сегодня) {
    история.push({ d: сегодня, v: текущая });
  } else {
    история[история.length - 1].v = текущая;
  }
  история = история.slice(-30);
  хранилище.setProperty('история', JSON.stringify(история));
  return история.map(function (т) { return т.v; });
}

/* ====================== отчёт в таблице ====================== */

function заполнитьОтчёт() {
  var цифры = собратьЦифры();
  var книга = SpreadsheetApp.openById(НАСТРОЙКИ.таблицаId);
  var лист = null;
  книга.getSheets().forEach(function (л) { if (л.getSheetId() === НАСТРОЙКИ.листGid) лист = л; });
  if (!лист) лист = книга.getSheets()[0];

  var шапка = лист.getRange(1, 1, 1, лист.getLastColumn()).getValues()[0]
    .map(function (з) { return String(з).toLowerCase(); });
  function колонка(шаблон) {
    for (var i = 0; i < шапка.length; i++) if (шаблон.test(шапка[i])) return i + 1;
    return 0;
  }

  var кДата = колонка(/дата|день/), кКвалы = колонка(/квал/), кЗамеры = колонка(/замер/),
      кДоговоры = колонка(/договор/), кСумма = колонка(/сумм|оборот|выручк/);

  var сегодня = Utilities.formatDate(new Date(), 'Europe/Moscow', 'dd.MM.yyyy');
  var строка = лист.getLastRow() + 1;

  if (кДата) лист.getRange(строка, кДата).setValue(сегодня);
  if (кКвалы) лист.getRange(строка, кКвалы).setValue(цифры.funnel.quals);
  if (кДоговоры) лист.getRange(строка, кДоговоры).setValue(цифры.funnel.contracts);
  if (кСумма) лист.getRange(строка, кСумма).setValue(цифры.plan.done);

  // Колонку замеров агент не трогает: её заполняет руководитель вручную.
  if (кЗамеры) {
    лист.getRange(строка, кЗамеры)
      .setNote('Оставлено пустым намеренно: количество замеров заполняется вручную.');
  }

  var ненайденные = [];
  if (!кДата) ненайденные.push('дата');
  if (!кКвалы) ненайденные.push('квалы');
  if (!кДоговоры) ненайденные.push('договоры');
  if (ненайденные.length) {
    Logger.log('Не нашёл колонки по заголовкам: ' + ненайденные.join(', ') +
      '. Шапка листа: ' + шапка.join(' | '));
  }
  return 'Строка ' + строка + ' заполнена';
}

/* ====================== сводка в Telegram ====================== */

/**
 * Находит ваш чат сам: достаточно один раз написать боту любое сообщение.
 * Найденный номер запоминается, повторно искать не нужно.
 */
function найтиЧат_() {
  if (НАСТРОЙКИ.telegramЧат) return НАСТРОЙКИ.telegramЧат;
  var хранилище = PropertiesService.getScriptProperties();
  var сохранённый = хранилище.getProperty('чат');
  if (сохранённый) return сохранённый;

  var ответ = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + НАСТРОЙКИ.telegramТокен + '/getUpdates',
    { muteHttpExceptions: true });
  var данные = JSON.parse(ответ.getContentText() || '{}');
  var обновления = данные.result || [];
  for (var i = обновления.length - 1; i >= 0; i--) {
    var сообщение = обновления[i].message || обновления[i].edited_message;
    if (сообщение && сообщение.chat && сообщение.chat.id) {
      var чат = String(сообщение.chat.id);
      хранилище.setProperty('чат', чат);
      return чат;
    }
  }
  return '';
}

function отправитьСводку() {
  if (!НАСТРОЙКИ.telegramТокен) return 'Telegram не настроен';
  var чат = найтиЧат_();
  if (!чат) return 'Напишите боту любое сообщение и запустите ещё раз: пока не вижу, в какой чат слать';
  var ц = собратьЦифры();
  var план = ц.plan.target ? Math.round(ц.plan.done / ц.plan.target * 100) : 0;
  var текст = [
    'Доброе утро. Сводка на ' + Utilities.formatDate(new Date(), 'Europe/Moscow', 'dd.MM'),
    '',
    'Конверсия в замер: ' + ц.conversion.current + '% при цели ' + ц.conversion.goal + '%',
    'План месяца: ' + план + '%',
    'Квалы ' + ц.funnel.quals + ' · замеры ' + ц.funnel.measures + ' · договоры ' + ц.funnel.contracts,
    '',
    ц.problems.length ? ('Требуют вас: ' + ц.problems.length) : 'Зависших сделок нет'
  ].join('\n');

  UrlFetchApp.fetch('https://api.telegram.org/bot' + НАСТРОЙКИ.telegramТокен + '/sendMessage', {
    method: 'post',
    payload: { chat_id: чат, text: текст },
    muteHttpExceptions: true
  });
  return 'Отправлено в чат ' + чат;
}

/* ====================== расписание ====================== */

function включитьРасписание() {
  ScriptApp.getProjectTriggers().forEach(function (т) { ScriptApp.deleteTrigger(т); });
  ScriptApp.newTrigger('заполнитьОтчёт').timeBased().atHour(8).nearMinute(30).everyDays(1).create();
  ScriptApp.newTrigger('отправитьСводку').timeBased().atHour(9).nearMinute(0).everyDays(1).create();
  return 'Расписание включено: отчёт в 8:30, сводка в 9:00';
}

/** Проверка связи. Запустите её первой: в журнале появятся ваши цифры. */
function проверка() {
  var ц = собратьЦифры();
  Logger.log('Квалы: ' + ц.funnel.quals + ', замеры: ' + ц.funnel.measures + ', договоры: ' + ц.funnel.contracts);
  Logger.log('Конверсия: ' + ц.conversion.current + '%');
  if (ц.warnings.length) Logger.log('Внимание: ' + ц.warnings.join('; '));
  Logger.log('Ваши воронки и этапы: ' + JSON.stringify(ц._ref));
  return ц;
}
