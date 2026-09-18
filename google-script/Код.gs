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

  // Таблица отчёта. Пусто означает «заведи свою и запомни».
  // Исходный отчёт отдела лежит в формате Excel и принадлежит другому человеку,
  // писать в него нельзя, поэтому агент ведёт собственную таблицу.
  таблицаId: '',

  // Telegram. Номер чата оставьте пустым: скрипт найдёт его сам,
  // как только вы напишете боту любое сообщение.
  telegramТокен: 'ВСТАВЬТЕ_ТОКЕН_БОТА',
  telegramЧат: ''
};

var ВЫИГРАНА = 142, ПРОИГРАНА = 143;

/**
 * Рабочие воронки и опорные этапы. Номера взяты из вашего аккаунта,
 * поэтому считаем точно, а не по совпадению слов в названии.
 */
var ВОРОНКИ = {
  5466436: {  // Основная воронка
    имя: 'Основная воронка',
    квал: 55021342,      // Квалифицированна
    замер: 48427108,     // Замер согласован
    неЗамер: []
  },
  10764258: { // Тихие стены
    имя: 'Тихие стены',
    квал: 84766366,      // квалифицирована
    замер: 87672278,     // замер назначен
    неЗамер: [84766370]  // «Отложенный спрос» стоит после замера, но замера там не было
  }
};
var ВОРОНКА_ОТЛОЖЕННЫХ = 10520622;

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

/** Начало текущего месяца в секундах. */
function началоМесяца_() {
  var н = new Date();
  return Math.floor(new Date(н.getFullYear(), н.getMonth(), 1).getTime() / 1000);
}

/** Забирает сделки страницами, чтобы ничего не потерялось при большом объёме. */
function страницы_(фильтр) {
  var всё = [], страница = 1;
  while (страница <= 12) {
    var параметры = { limit: 250, page: страница };
    for (var к in фильтр) параметры[к] = фильтр[к];
    var порция = ((запросAmo_('leads', параметры) || {})._embedded || {}).leads || [];
    всё = всё.concat(порция);
    if (порция.length < 250) break;
    страница++;
    Utilities.sleep(300); // AmoCRM не любит больше семи обращений в секунду
  }
  return всё;
}

/** Сделки, пришедшие в этом месяце. По ним считаются заявки, квалы и замеры. */
function сделкиЗаМесяц_() {
  return страницы_({ 'filter[created_at][from]': началоМесяца_() });
}

/**
 * Сделки, подписанные в этом месяце, независимо от того, когда они пришли.
 * План закрывается датой подписания: сделка из августа, подписанная в сентябре,
 * идёт в сентябрьскую выручку. По дате создания она бы потерялась.
 */
function сделкиЗакрытые_() {
  return страницы_({ 'filter[closed_at][from]': началоМесяца_() })
    .filter(function (с) { return с.status_id === ВЫИГРАНА; });
}

function собратьЦифры() {
  var воронки = (запросAmo_('leads/pipelines')._embedded || {}).pipelines || [];
  var сделки = сделкиЗаМесяц_();
  var люди = (запросAmo_('users')._embedded || {}).users || [];

  // Порядок этапов: номер этапа -> {порядок, воронка, название}
  var этапы = {}, справочник = [];
  воронки.forEach(function (в) {
    var список = (в._embedded || {}).statuses || [];
    справочник.push({
      воронка: в.name, id: в.id,
      этапы: список.map(function (с) { return { id: с.id, название: с.name, порядок: с.sort }; })
    });
    список.forEach(function (с) { этапы[с.id] = { порядок: с.sort, воронка: в.id, название: с.name }; });
  });

  var замечания = [];
  for (var код in ВОРОНКИ) {
    var н = ВОРОНКИ[код];
    if (!этапы[н.квал]) замечания.push('в воронке «' + н.имя + '» пропал этап квалификации');
    if (!этапы[н.замер]) замечания.push('в воронке «' + н.имя + '» пропал этап замера');
  }

  // Сделка дошла до опорного этапа, если её этап не раньше по порядку.
  function дошла(сделка, опорный, исключения) {
    if (сделка.status_id === ВЫИГРАНА) return true;
    if (сделка.status_id === ПРОИГРАНА) return false;
    if (исключения && исключения.indexOf(сделка.status_id) > -1) return false;
    var текущий = этапы[сделка.status_id], цель = этапы[опорный];
    if (!текущий || !цель) return false;
    return текущий.порядок >= цель.порядок;
  }

  var рабочие = сделки.filter(function (с) {
    return ВОРОНКИ[с.pipeline_id] && с.status_id !== ПРОИГРАНА;
  });
  var отложенные = сделки.filter(function (с) {
    return с.pipeline_id === ВОРОНКА_ОТЛОЖЕННЫХ && с.status_id !== ПРОИГРАНА;
  }).length;

  var закрытые = сделкиЗакрытые_().filter(function (с) { return ВОРОНКИ[с.pipeline_id]; });
  var договоры = закрытые.length;
  var сумма = закрытые.reduce(function (и, с) { return и + (с.price || 0); }, 0);

  var квалы = 0, замеры = 0, поВоронкам = {};
  рабочие.forEach(function (с) {
    var н = ВОРОНКИ[с.pipeline_id];
    поВоронкам[н.имя] = поВоронкам[н.имя] || { квалы: 0, замеры: 0, договоры: 0 };
    if (дошла(с, н.квал, null)) { квалы++; поВоронкам[н.имя].квалы++; }
    if (дошла(с, н.замер, н.неЗамер)) { замеры++; поВоронкам[н.имя].замеры++; }
  });
  закрытые.forEach(function (с) {
    var имя = ВОРОНКИ[с.pipeline_id].имя;
    поВоронкам[имя] = поВоронкам[имя] || { квалы: 0, замеры: 0, договоры: 0 };
    поВоронкам[имя].договоры++;
  });

  var поЛюдям = {};
  рабочие.forEach(function (с) {
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
  var проблемы = рабочие.filter(function (с) {
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
    deferred: отложенные,
    byPipeline: поВоронкам,
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

var ШАПКА = ['Дата', 'Заявок за день', 'Квалов с начала месяца', 'Замеров по CRM',
             'Замеров вручную', 'Договоров за день', 'Сумма за день', 'Сумма с начала месяца',
             'Выполнение плана %', 'Комментарий агента'];

var МЕСЯЦЫ = ['Январь','Февраль','Март','Апрель','Май','Июнь',
              'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

/**
 * Возвращает книгу для отчёта. Исходный файл отдела лежит в формате Excel
 * и принадлежит другому человеку, писать в него нельзя, поэтому агент
 * заводит собственную таблицу и запоминает её навсегда.
 */
function книгаОтчёта_() {
  var хранилище = PropertiesService.getScriptProperties();
  var id = хранилище.getProperty('таблицаОтчёта');
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) { хранилище.deleteProperty('таблицаОтчёта'); }
  }
  if (НАСТРОЙКИ.таблицаId) {
    try {
      var своя = SpreadsheetApp.openById(НАСТРОЙКИ.таблицаId);
      хранилище.setProperty('таблицаОтчёта', НАСТРОЙКИ.таблицаId);
      return своя;
    } catch (e) {
      Logger.log('Настроенный файл открыть не получилось: это книга Excel, а не Google-таблица. Создаю отдельную.');
    }
  }
  var книга = SpreadsheetApp.create('Shumm · отчёт по продажам');
  хранилище.setProperty('таблицаОтчёта', книга.getId());
  Logger.log('Создал таблицу отчёта: ' + книга.getUrl());
  return книга;
}

/** Лист текущего месяца. Создаётся при первом обращении, как в отчёте отдела. */
function листМесяца_(книга) {
  var сейчас = new Date();
  var имя = МЕСЯЦЫ[сейчас.getMonth()] + ' ' + сейчас.getFullYear();
  var лист = книга.getSheetByName(имя);
  if (лист) return лист;

  лист = книга.insertSheet(имя);
  лист.getRange(1, 1).setValue('ПЛАН');
  лист.getRange(1, 2).setValue(НАСТРОЙКИ.планМесяца);
  лист.getRange(1, 3).setValue('Цель по конверсии');
  лист.getRange(1, 4).setValue(НАСТРОЙКИ.цельКонверсии / 100);
  лист.getRange(1, 4).setNumberFormat('0%');
  лист.getRange(2, 1, 1, ШАПКА.length).setValues([ШАПКА]).setFontWeight('bold');
  лист.setFrozenRows(2);
  лист.getRange(3, 1, 400, 1).setNumberFormat('dd.MM.yyyy');
  лист.getRange(3, 7, 400, 2).setNumberFormat('# ##0 \u20BD');
  лист.getRange(3, 9, 400, 1).setNumberFormat('0%');
  лист.setColumnWidth(10, 320);

  var первый = книга.getSheets()[0];
  if (первый.getName() === 'Лист1' && первый.getLastRow() === 0) книга.deleteSheet(первый);
  return лист;
}

/** Сколько заявок пришло и сколько договоров подписано именно сегодня. */
function заСегодня_(пришедшие, закрытые) {
  var н = new Date(); н.setHours(0, 0, 0, 0);
  var начало = Math.floor(н.getTime() / 1000), конец = начало + 86400;
  var заявки = 0, договоры = 0, сумма = 0;
  пришедшие.forEach(function (с) {
    if (с.created_at >= начало && с.created_at < конец) заявки++;
  });
  закрытые.forEach(function (с) {
    if (с.closed_at >= начало && с.closed_at < конец) { договоры++; сумма += с.price || 0; }
  });
  return { заявки: заявки, договоры: договоры, сумма: сумма };
}

function заполнитьОтчёт() {
  var ц = собратьЦифры(true);
  var свои = function (список) { return список.filter(function (с) { return ВОРОНКИ[с.pipeline_id]; }); };
  var сегодня = заСегодня_(свои(сделкиЗаМесяц_()), свои(сделкиЗакрытые_()));

  var лист = листМесяца_(книгаОтчёта_());
  var дата = Utilities.formatDate(new Date(), 'Europe/Moscow', 'dd.MM.yyyy');

  // Ищем строку сегодняшнего дня, чтобы повторный запуск не плодил дубликаты.
  var строка = 0, всего = лист.getLastRow();
  if (всего >= 3) {
    var даты = лист.getRange(3, 1, всего - 2, 1).getDisplayValues();
    for (var i = 0; i < даты.length; i++) if (даты[i][0] === дата) { строка = i + 3; break; }
  }
  if (!строка) строка = Math.max(3, всего + 1);

  var комментарий = '';
  if (ц.warnings && ц.warnings.length) комментарий = ц.warnings.join('; ');
  if (!комментарий && ц.problems.length) комментарий = 'Зависших сделок: ' + ц.problems.length;

  лист.getRange(строка, 1, 1, ШАПКА.length).setValues([[
    дата,
    сегодня.заявки,
    ц.funnel.quals,
    ц.funnel.measures,
    '',                      // замеры вручную: эту клетку агент не трогает
    сегодня.договоры,
    сегодня.сумма,
    ц.plan.done,
    НАСТРОЙКИ.планМесяца ? ц.plan.done / НАСТРОЙКИ.планМесяца : 0,
    комментарий
  ]]);

  лист.getRange(строка, 5).setNote(
    'Оставлено пустым намеренно: количество замеров заполняет руководитель. ' +
    'Рядом, в колонке «Замеров по CRM», стоит то, что видит AmoCRM.');

  Logger.log('Отчёт заполнен, строка ' + строка + ' листа «' + лист.getName() + '».');
  Logger.log('Таблица: ' + лист.getParent().getUrl());
  return 'Готово';
}

/** Показывает, где живёт таблица отчёта. */
function адресОтчёта() {
  var книга = книгаОтчёта_();
  Logger.log('Таблица отчёта: ' + книга.getUrl());
  return книга.getUrl();
}

/* ====================== сводка в Telegram ====================== */

/**
 * Находит ваш чат сам: достаточно один раз написать боту любое сообщение.
 * Найденный номер запоминается, повторно искать не нужно.
 */
function найтиЧат_() {
  if (НАСТРОЙКИ.telegramЧат) { Logger.log('Чат взят из настроек: ' + НАСТРОЙКИ.telegramЧат); return НАСТРОЙКИ.telegramЧат; }
  var хранилище = PropertiesService.getScriptProperties();
  var сохранённый = хранилище.getProperty('чат');
  if (сохранённый) { Logger.log('Чат уже был найден раньше: ' + сохранённый); return сохранённый; }

  var ответ = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + НАСТРОЙКИ.telegramТокен + '/getUpdates',
    { muteHttpExceptions: true });
  var код = ответ.getResponseCode();
  var тело = ответ.getContentText();
  Logger.log('Спросил у Telegram новые сообщения, ответ ' + код);
  if (код !== 200) {
    Logger.log('Telegram отказал. Это почти всегда неверный токен бота. Ответ: ' + тело.slice(0, 300));
    return '';
  }
  var данные = JSON.parse(тело || '{}');
  var обновления = данные.result || [];
  Logger.log('Сообщений в очереди: ' + обновления.length);
  if (!обновления.length) {
    Logger.log('Очередь пуста. Причины бывают две: вы ещё не писали боту, либо сообщения уже забрал ' +
      'другой сервис, подключённый к этому же боту. Напишите боту ещё раз и запустите снова.');
  }
  for (var i = обновления.length - 1; i >= 0; i--) {
    var сообщение = обновления[i].message || обновления[i].edited_message;
    if (сообщение && сообщение.chat && сообщение.chat.id) {
      var чат = String(сообщение.chat.id);
      хранилище.setProperty('чат', чат);
      Logger.log('Нашёл ваш чат: ' + чат + '. Запомнил, больше искать не буду.');
      return чат;
    }
  }
  return '';
}

/** Разбирает по шагам, почему сводка не дошла. Запускать при любой заминке с Telegram. */
function проверкаTelegram() {
  if (!НАСТРОЙКИ.telegramТокен || НАСТРОЙКИ.telegramТокен.indexOf('ВСТАВЬТЕ') === 0) {
    Logger.log('Токен бота не вписан в настройки.');
    return;
  }
  var кто = UrlFetchApp.fetch('https://api.telegram.org/bot' + НАСТРОЙКИ.telegramТокен + '/getMe',
    { muteHttpExceptions: true });
  if (кто.getResponseCode() !== 200) {
    Logger.log('Telegram не признал токен. Ответ: ' + кто.getContentText().slice(0, 300));
    return;
  }
  var имя = (JSON.parse(кто.getContentText()).result || {}).username;
  Logger.log('Бот на связи: @' + имя + '. Именно ему нужно написать сообщение.');

  var чат = найтиЧат_();
  if (!чат) { Logger.log('Чат не найден, отправлять некуда.'); return; }

  var отправка = UrlFetchApp.fetch('https://api.telegram.org/bot' + НАСТРОЙКИ.telegramТокен + '/sendMessage', {
    method: 'post',
    payload: { chat_id: чат, text: 'Shumm на связи. Это проверочное сообщение.' },
    muteHttpExceptions: true
  });
  Logger.log('Отправка, ответ ' + отправка.getResponseCode() + ': ' + отправка.getContentText().slice(0, 300));
}

/** Забывает найденный чат, чтобы искать заново. */
function сброситьЧат() {
  PropertiesService.getScriptProperties().deleteProperty('чат');
  Logger.log('Чат забыт. Напишите боту и запустите проверкаTelegram.');
}

function отправитьСводку() {
  if (!НАСТРОЙКИ.telegramТокен) { Logger.log('Токен бота не вписан.'); return 'Telegram не настроен'; }
  var чат = найтиЧат_();
  if (!чат) {
    Logger.log('Не знаю, в какой чат слать. Напишите боту сообщение и запустите проверкаTelegram.');
    return 'Чат не найден';
  }
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

  var ответ = UrlFetchApp.fetch('https://api.telegram.org/bot' + НАСТРОЙКИ.telegramТокен + '/sendMessage', {
    method: 'post',
    payload: { chat_id: чат, text: текст },
    muteHttpExceptions: true
  });
  Logger.log('Отправка сводки в чат ' + чат + ', ответ ' + ответ.getResponseCode() +
    ': ' + ответ.getContentText().slice(0, 300));
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
  Logger.log('ИТОГО за месяц: квалы ' + ц.funnel.quals + ', замеры ' + ц.funnel.measures +
    ', договоры ' + ц.funnel.contracts + ', сумма ' + ц.plan.done + ' руб');
  Logger.log('Конверсия квал → замер: ' + ц.conversion.current + '% при цели ' + ц.conversion.goal + '%');
  Logger.log('По воронкам: ' + JSON.stringify(ц.byPipeline));
  Logger.log('В отложенном спросе: ' + ц.deferred);
  Logger.log('Менеджеры: ' + JSON.stringify(ц.managers));
  Logger.log('Зависших сделок: ' + ц.problems.length);
  if (ц.warnings.length) Logger.log('Внимание: ' + ц.warnings.join('; '));
  return ц;
}
