// Движок возврата клиентов из воронки «Условный отказ» (AmoCRM 5518450).
// Действия (поле action в теле запроса):
//   plan    — сухой прогон: кого и чем коснулся бы движок сегодня, ничего не меняя;
//   run     — утренний запуск: новые цепочки и очередные касания;
//   otvety  — проверка ответов клиентов: ответивших возвращает в Основную воронку.
// Отправка идёт только через Salesbot (id в uo_nastroyki.bot_id) и только при vklyucheno = 'да'.
// Тексты берутся только со статусом «согласован». Имена и телефоны в Supabase не сохраняются.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("AMO_TOKEN") ?? "";
const DOMAIN = Deno.env.get("AMO_DOMAIN") ?? "macridin";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const UO = 5518450, MAIN = 5466436, WON = 142, LOST = 143;
const FIELD_TEXT = 947395, FIELD_SEG = 947397, FIELD_N = 947399;
const PRICHINA: Record<number, string> = {
  48799201: "dorogo", 48799204: "konkurenty", 48799207: "sam",
  48799729: "ne_na_svyazi", 83345482: "ne_na_svyazi",
};
const ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function amo(method: string, path: string, body?: unknown): Promise<any> {
  const url = `https://${DOMAIN}.amocrm.ru/api/${path.startsWith("v2/") ? path : "v4/" + path}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1500 * attempt); continue; }
    await sleep(160);
    if (res.status === 204) return {};
    const text = await res.text();
    if (res.status >= 400) throw new Error(`AmoCRM ${res.status} на ${method} ${path}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

async function settings() {
  const { data } = await db.from("uo_nastroyki").select("k, v");
  return Object.fromEntries((data ?? []).map((r: any) => [r.k, r.v]));
}
const log = (lead_id: number | null, deystvie: string, info: unknown = null) =>
  db.from("uo_zhurnal").insert({ lead_id, deystvie, info });

function segmentOf(tags: string[]): string {
  const has = (t: string) => tags.includes(t);
  if (["Встреча проведена", "Смету отправил", "Договор подписан", "Встреча согласована"].some(has)) return "A";
  if (["Замер проведен", "Замер согласован"].some(has)) return "B";
  if (["Квалифицирована", "Взята в работу", "Получена заявка"].some(has)) return "C";
  return "D";
}

function objectOf(lead: any): string {
  const usl = (lead.custom_fields_values ?? []).find((f: any) => f.field_name === "Услуга")?.values?.[0]?.value ?? "";
  if (/1-комн/.test(usl)) return "однокомнатной квартиры";
  if (/2-комн/.test(usl)) return "двухкомнатной квартиры";
  if (/дом/i.test(usl)) return "дома";
  if (/офис/i.test(usl)) return "офиса";
  return "квартиры";
}

const FIRST_NAMES = ["Сергей", "Максим", "Иван", "Артём", "Артем", "Алексей"];
function managerOf(fullName: string): string {
  const parts = String(fullName ?? "").split(/\s+/).filter(Boolean);
  return parts.find((p) => FIRST_NAMES.includes(p)) ?? parts[0] ?? "";
}

function clientName(contactName: string): string {
  const first = String(contactName ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[А-ЯЁA-Z][а-яёa-z-]{1,20}$/.test(first) ? first : "";
}

// Подставляет имя, менеджера и объект. Без имени клиента обращение аккуратно убирается.
function render(tpl: string, name: string, manager: string, object: string, segment: string, prichina: string, kasanie: number) {
  let t = tpl.replaceAll("{менеджер}", manager).replaceAll("{объект}", object);
  if (prichina === "ne_na_svyazi" && kasanie === 1) {
    const lead = segment === "A" ? "мы с вами встречались по ремонту"
      : segment === "B" ? "мы приезжали к вам на замер"
      : segment === "D" ? "вы когда-то спрашивали у нас про ремонт"
      : "вы оставляли у нас заявку на ремонт";
    t = t.replace("вы оставляли у нас заявку на ремонт", lead);
  }
  if (name) return t.replaceAll("{имя}", name);
  return t
    .replace(/^\{имя\},\s*(\S)/, (_m, c) => c.toUpperCase())
    .replace(/,\s*\{имя\}/g, "")
    .replaceAll("{имя}", "");
}

async function texts() {
  const { data } = await db.from("uo_teksty").select("*").eq("status", "согласован");
  const map: Record<string, any> = {};
  for (const r of data ?? []) map[`${r.prichina}:${r.kasanie}`] = r;
  return map;
}

async function leadsInUO() {
  const leads: any[] = [];
  for (let page = 1; page <= 40; page++) {
    const part = (await amo("GET", `leads?filter[pipeline_id][0]=${UO}&with=contacts&limit=250&page=${page}`))?._embedded?.leads ?? [];
    leads.push(...part);
    if (part.length < 250) break;
  }
  return leads;
}

async function usersMap() {
  const out: Record<number, string> = {};
  for (const u of (await amo("GET", "users?limit=250"))?._embedded?.users ?? []) out[u.id] = u.name;
  return out;
}

async function contactOf(lead: any) {
  const id = lead._embedded?.contacts?.find((c: any) => c.is_main)?.id ?? lead._embedded?.contacts?.[0]?.id;
  if (!id) return null;
  const c = await amo("GET", `contacts/${id}`);
  const hasPhone = (c.custom_fields_values ?? []).some((f: any) => f.field_code === "PHONE" && f.values?.length);
  return { name: c.name ?? "", hasPhone };
}

async function morning(dry: boolean) {
  const s = await settings();
  const botId = Number(s.bot_id) || 0;
  const sending = !dry && s.vklyucheno === "да" && botId > 0;
  const limit = Number(s.limit_v_den) || 50;
  const exclude = String(s.isklyuchit_otvetstvennyh ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const tpl = await texts();
  const users = await usersMap();
  const leads = await leadsInUO();
  const byId = new Map(leads.map((l) => [l.id, l]));

  const { data: stateRows } = await db.from("uo_sostoyanie").select("*");
  const state = new Map((stateRows ?? []).map((r: any) => [Number(r.lead_id), r]));
  const report = { отправлено: 0, задач_на_звонок: 0, новых_цепочек: 0, вышли_из_воронки: 0, пропущено: {} as Record<string, number>, примеры: [] as any[] };
  const skip = (why: string) => (report.пропущено[why] = (report.пропущено[why] ?? 0) + 1);

  // Сделки, которые менеджер сам вывел из «Условного отказа», из цепочки выходят.
  for (const r of stateRows ?? []) {
    if (r.status === "идёт" && !byId.has(Number(r.lead_id))) {
      report.вышли_из_воронки++;
      if (!dry) {
        await db.from("uo_sostoyanie").update({ status: "вышла", obnovleno_at: new Date().toISOString() }).eq("lead_id", r.lead_id);
        await log(Number(r.lead_id), "вышла из воронки");
      }
    }
  }

  // Кандидаты: новые цепочки по приоритету сегмента и бюджета, плюс те, кому пора следующее касание.
  const now = Date.now();
  const due: { lead: any; st: any }[] = [];
  const fresh: any[] = [];
  for (const l of leads) {
    const prichina = PRICHINA[l.status_id];
    if (!prichina || l.status_id === WON || l.status_id === LOST) { skip("этап не для рассылки"); continue; }
    if (exclude.some((x) => (users[l.responsible_user_id] ?? "").includes(x))) { skip("ответственный исключён"); continue; }
    const st = state.get(l.id);
    if (!st) fresh.push(l);
    else if (st.status === "идёт" && new Date(st.sleduyushee_at).getTime() <= now) due.push({ lead: l, st });
  }
  fresh.sort((a, b) => {
    const sa = ORDER[segmentOf((a._embedded?.tags ?? []).map((t: any) => t.name))];
    const sb = ORDER[segmentOf((b._embedded?.tags ?? []).map((t: any) => t.name))];
    return sa - sb || (b.price ?? 0) - (a.price ?? 0);
  });
  const newOnes = fresh.slice(0, Math.max(0, limit - due.length));

  const work = [...due, ...newOnes.map((lead) => ({ lead, st: null }))];
  for (const { lead, st } of work) {
    const tags = (lead._embedded?.tags ?? []).map((t: any) => t.name);
    const segment = st?.segment ?? segmentOf(tags);
    const prichina = st?.prichina ?? PRICHINA[lead.status_id];
    const sent = st?.kasanie ?? 0;
    const next = sent + 1;

    // «Дорого» в сегментах A и B: сначала звонок менеджера, сообщение — на следующий день.
    if (!st && prichina === "dorogo" && (segment === "A" || segment === "B")) {
      report.задач_на_звонок++;
      report.новых_цепочек++;
      if (!dry) {
        await amo("POST", "tasks", [{
          entity_id: lead.id, entity_type: "leads", responsible_user_id: lead.responsible_user_id,
          text: "Возврат из «Условного отказа»: позвонить клиенту. Если не дозвонитесь, завтра ему автоматически уйдёт сообщение.",
          complete_till: Math.floor(now / 1000) + 8 * 3600,
        }]);
        await db.from("uo_sostoyanie").insert({ lead_id: lead.id, prichina, segment, kasanie: 0, sleduyushee_at: new Date(now + 20 * 3600 * 1000).toISOString() });
        await log(lead.id, "задача на звонок", { segment, prichina });
      }
      continue;
    }

    const t = tpl[`${prichina}:${next}`];
    if (!t) { skip("нет согласованного текста"); continue; }
    const contact = await contactOf(lead);
    if (!contact?.hasPhone) {
      skip("нет телефона");
      if (!dry) {
        await db.from("uo_sostoyanie").upsert({ lead_id: lead.id, prichina, segment, kasanie: sent, status: "завершено", obnovleno_at: new Date().toISOString() });
        await log(lead.id, "нет телефона, пропущена");
      }
      continue;
    }
    const message = render(t.tekst, clientName(contact.name), managerOf(users[lead.responsible_user_id]), objectOf(lead), segment, prichina, next);
    if (report.примеры.length < 3) report.примеры.push({ сделка: lead.id, сегмент: segment, причина: prichina, касание: next, текст: message.replace(clientName(contact.name) || "\u0000", "{имя}") });
    if (!st) report.новых_цепочек++;

    if (!sending) { skip(dry ? "сухой прогон" : "отправка выключена"); continue; }

    await amo("PATCH", `leads/${lead.id}`, {
      custom_fields_values: [
        { field_id: FIELD_TEXT, values: [{ value: message }] },
        { field_id: FIELD_SEG, values: [{ value: `${segment} · ${prichina}` }] },
        { field_id: FIELD_N, values: [{ value: next }] },
      ],
    });
    await amo("POST", "v2/salesbot/run", [{ bot_id: botId, entity_id: lead.id, entity_type: 2 }]);
    await amo("POST", `leads/${lead.id}/notes`, [{ note_type: "common", params: { text: `Возврат из «Условного отказа»: отправлено сообщение ${next} из 3.` } }]);
    const delayDays = tpl[`${prichina}:${next + 1}`]?.cherez_dney ?? 0;
    await db.from("uo_sostoyanie").upsert({
      lead_id: lead.id, prichina, segment, kasanie: next,
      status: next >= 3 ? "завершено" : "идёт",
      sleduyushee_at: new Date(now + delayDays * 86400 * 1000).toISOString(),
      obnovleno_at: new Date().toISOString(),
    });
    await log(lead.id, `отправлено касание ${next}`, { segment, prichina });
    report.отправлено++;
  }
  return { режим: dry ? "сухой прогон" : sending ? "отправка" : "отправка выключена", кандидатов_всего: fresh.length + due.length, ...report };
}

// Ответы клиентов: входящее сообщение по сделке из цепочки — сделка уходит в Основную воронку.
async function replies() {
  const s = await settings();
  const since = Number(s.poslednyaya_proverka_otvetov) || Math.floor(Date.now() / 1000) - 3600;
  const startedAt = Math.floor(Date.now() / 1000);
  const { data: active } = await db.from("uo_sostoyanie").select("lead_id").eq("status", "идёт").gt("kasanie", 0);
  const ids = new Set((active ?? []).map((r: any) => Number(r.lead_id)));
  const ev = (await amo("GET", `events?limit=100&filter[type]=incoming_chat_message&filter[created_at][from]=${since}`))?._embedded?.events ?? [];

  const pipelines = (await amo("GET", `leads/pipelines/${MAIN}`))?._embedded?.statuses ?? [];
  const takenStatus = pipelines.find((x: any) => /взята в работу/i.test(x.name))?.id ?? pipelines.find((x: any) => x.type === 0 && x.sort > 10)?.id;

  // Входящие сообщения AmoCRM привязывает к контакту или сделке: проверяем обе связи.
  const hits = new Set<number>();
  for (const e of ev) {
    if (e.entity_type === "lead" && ids.has(Number(e.entity_id))) hits.add(Number(e.entity_id));
    if (e.entity_type === "contact") {
      const c = await amo("GET", `contacts/${e.entity_id}?with=leads`);
      for (const l of c?._embedded?.leads ?? []) if (ids.has(Number(l.id))) hits.add(Number(l.id));
    }
  }
  for (const id of hits) {
    const lead = await amo("GET", `leads/${id}`);
    await amo("PATCH", `leads/${id}`, { pipeline_id: MAIN, status_id: takenStatus });
    await amo("POST", "tasks", [{
      entity_id: id, entity_type: "leads", responsible_user_id: lead.responsible_user_id,
      text: "Клиент ответил на сообщение возврата из «Условного отказа». Ответьте ему в течение 30 минут.",
      complete_till: Math.floor(Date.now() / 1000) + 1800,
    }]);
    await db.from("uo_sostoyanie").update({ status: "ответил", obnovleno_at: new Date().toISOString() }).eq("lead_id", id);
    await log(id, "клиент ответил, сделка в Основной воронке");
  }
  await db.from("uo_nastroyki").update({ v: String(startedAt) }).eq("k", "poslednyaya_proverka_otvetov");
  return { проверено_событий: ev.length, ответили: hits.size };
}

Deno.serve(async (req) => {
  const { data: key } = await db.from("sluzhebnoe").select("v").eq("k", "ключ_функций").single();
  if (!key || req.headers.get("x-shumm-key") !== key.v) return Response.json({ error: "нет доступа" }, { status: 403 });
  if (!TOKEN) return Response.json({ error: "Не задан секрет AMO_TOKEN" }, { status: 500 });
  const { action } = await req.json().catch(() => ({}));
  try {
    if (action === "plan") return Response.json(await morning(true));
    if (action === "run") return Response.json(await morning(false));
    if (action === "otvety") return Response.json(await replies());
    return Response.json({ error: "неизвестное действие" }, { status: 400 });
  } catch (e) {
    await log(null, "ошибка", { action, ошибка: String((e as Error)?.message ?? e) });
    return Response.json({ error: String((e as Error)?.message ?? e) }, { status: 500 });
  }
});
