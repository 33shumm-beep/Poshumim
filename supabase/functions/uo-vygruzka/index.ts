// Выгрузка воронки «Условный отказ» из AmoCRM для разбора.
// Только читает CRM. Пишет в таблицу uo_razbor без имён и телефонов клиентов.
// Секреты проекта: AMO_TOKEN (долгосрочный токен), AMO_DOMAIN (macridin).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("AMO_TOKEN") ?? "";
const DOMAIN = Deno.env.get("AMO_DOMAIN") ?? "macridin";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const WON = 142, LOST = 143;
const CALL_STATUS: Record<number, string> = {
  1: "оставил сообщение", 2: "перезвонить позже", 3: "нет на месте", 4: "разговор состоялся",
  5: "неверный номер", 6: "не дозвонился", 7: "занято",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function amo(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.append(k, String(v));
  const url = `https://${DOMAIN}.amocrm.ru/api/v4/${path}${q.size ? "?" + q : ""}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 204) return {};
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1500 * attempt); continue; }
    if (res.status === 401) throw new Error("AmoCRM не принял токен");
    if (res.status >= 400) throw new Error(`AmoCRM ответил ${res.status} на ${path}`);
    await sleep(160); // AmoCRM разрешает до 7 запросов в секунду
    return await res.json();
  }
}

function withIds(field: string, ids: (number | string)[], rest: Record<string, string | number> = {}) {
  const p: Record<string, string | number> = { ...rest };
  ids.forEach((id, i) => (p[`filter[${field}][${i}]`] = id));
  return p;
}

const day = (ts?: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");
// Номера телефонов и почты в заметках замазываются: в разборе они не нужны.
const clean = (s: string, n = 300) =>
  String(s ?? "")
    .replace(/\+?\d[\d\s\-()]{8,}\d/g, "[телефон]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[почта]")
    .replace(/\s+/g, " ").trim().slice(0, n);

async function run(runId: number) {
  const pipelines = (await amo("leads/pipelines"))._embedded?.pipelines ?? [];
  const allStages: Record<number, { pipeline: string; stage: string }> = {};
  for (const p of pipelines) for (const s of p._embedded?.statuses ?? []) allStages[s.id] = { pipeline: p.name, stage: s.name };
  const uo = pipelines.find((p: any) => /условн/i.test(p.name));
  if (!uo) throw new Error("Нет воронки со словом «условн». Есть: " + pipelines.map((p: any) => p.name).join(", "));
  const stages = (uo._embedded?.statuses ?? []).map((s: any) => ({ id: s.id, name: s.name, sort: s.sort }));

  const leads: any[] = [];
  for (let page = 1; page <= 40; page++) {
    const part = (await amo("leads", { "filter[pipeline_id][0]": uo.id, with: "contacts,loss_reason", limit: 250, page }))._embedded?.leads ?? [];
    leads.push(...part);
    if (part.length < 250) break;
  }
  const users: Record<number, string> = {};
  for (const u of (await amo("users", { limit: 250 }))._embedded?.users ?? []) users[u.id] = u.name;

  const info: Record<number, any> = {};
  for (const l of leads) info[l.id] = { notes: [], calls: 0, reached: 0, lastCall: "", lastCallTs: 0, touch: 0, cameAt: 0, cameFrom: "", task: "", phone: false };
  const ids = leads.map((l) => l.id);

  for (let i = 0; i < ids.length; i += 50) {
    for (let page = 1; page <= 8; page++) {
      const notes = (await amo("leads/notes", withIds("entity_id", ids.slice(i, i + 50), { limit: 250, page })))._embedded?.notes ?? [];
      for (const n of notes) {
        const d = info[n.entity_id]; if (!d) continue;
        const p = n.params ?? {};
        let text = "";
        if (n.note_type === "call_in" || n.note_type === "call_out") {
          d.calls++;
          if (p.call_status === 4 || (p.duration ?? 0) > 20) d.reached++;
          const st = CALL_STATUS[p.call_status] ?? `статус ${p.call_status ?? "?"}`;
          text = `${n.note_type === "call_in" ? "входящий" : "исходящий"} звонок, ${p.duration ?? 0} с, ${st}${p.call_result ? ": " + p.call_result : ""}`;
          if (n.created_at > d.lastCallTs) { d.lastCallTs = n.created_at; d.lastCall = `${day(n.created_at)}, ${st}, ${p.duration ?? 0} с`; }
        } else {
          text = p.text ?? p.service ?? "";
          if (!text) continue;
          text = `[${n.note_type}] ${text}`;
        }
        d.touch = Math.max(d.touch, n.created_at ?? 0);
        d.notes.push({ t: n.created_at ?? 0, s: `${day(n.created_at)} ${clean(text)}` });
      }
      if (notes.length < 250) break;
    }
  }

  for (let i = 0; i < ids.length; i += 10) {
    const events = (await amo("events", withIds("entity_id", ids.slice(i, i + 10),
      { "filter[entity]": "lead", "filter[type]": "lead_status_changed", limit: 100 })))._embedded?.events ?? [];
    for (const e of events) {
      const d = info[e.entity_id]; if (!d) continue;
      const after = e.value_after?.[0]?.lead_status ?? {}, before = e.value_before?.[0]?.lead_status ?? {};
      if (Number(after.pipeline_id) !== uo.id || Number(before.pipeline_id) === uo.id) continue;
      if (e.created_at > d.cameAt) {
        d.cameAt = e.created_at;
        const s = allStages[before.id];
        d.cameFrom = s ? `${s.pipeline} → ${s.stage}` : `этап ${before.id ?? "?"}`;
      }
    }
  }

  for (let i = 0; i < ids.length; i += 50) {
    const tasks = (await amo("tasks", withIds("entity_id", ids.slice(i, i + 50),
      { "filter[entity_type]": "leads", "filter[is_completed]": 0, limit: 250 })))._embedded?.tasks ?? [];
    for (const t of tasks) if (info[t.entity_id]) info[t.entity_id].task = `${day(t.complete_till)} ${clean(t.text, 100)}`;
  }

  const contactLeads: Record<string, number[]> = {};
  for (const l of leads) for (const c of l._embedded?.contacts ?? []) (contactLeads[c.id] ??= []).push(l.id);
  const cids = Object.keys(contactLeads);
  for (let i = 0; i < cids.length; i += 50) {
    const contacts = (await amo("contacts", withIds("id", cids.slice(i, i + 50), { limit: 250 })))._embedded?.contacts ?? [];
    for (const c of contacts) {
      const has = (c.custom_fields_values ?? []).some((f: any) => f.field_code === "PHONE" && f.values?.length);
      if (has) for (const id of contactLeads[c.id] ?? []) info[id].phone = true;
    }
  }

  const now = Date.now() / 1000;
  const stageName = Object.fromEntries(stages.map((s: any) => [s.id, s.name]));
  const rows = leads.map((l) => {
    const d = info[l.id];
    const came = d.cameAt || l.updated_at;
    const fields: Record<string, string> = {};
    for (const f of l.custom_fields_values ?? []) {
      if (f.field_code === "PHONE" || f.field_code === "EMAIL") continue;
      fields[f.field_name] = clean((f.values ?? []).map((v: any) => v.value).join("/"), 120);
    }
    return {
      lead_id: l.id,
      data: {
        этап: stageName[l.status_id] ?? (l.status_id === LOST ? "закрыто и не реализовано" : l.status_id === WON ? "успешно" : String(l.status_id)),
        бюджет: l.price ?? 0,
        ответственный: users[l.responsible_user_id] ?? "",
        создана: day(l.created_at),
        в_отказе_с: day(came),
        дней_в_отказе: Math.round((now - came) / 86400),
        откуда: d.cameFrom,
        причина: l._embedded?.loss_reason?.[0]?.name ?? "",
        метки: (l._embedded?.tags ?? []).map((t: any) => t.name),
        поля: fields,
        телефон_есть: d.phone,
        звонков: d.calls, дозвонов: d.reached, последний_звонок: d.lastCall,
        последнее_касание: day(d.touch),
        открытая_задача: d.task,
        заметки: d.notes.sort((a: any, b: any) => b.t - a.t).slice(0, 12).map((n: any) => n.s),
      },
      loaded_at: new Date().toISOString(),
    };
  });

  await db.from("uo_razbor").delete().gte("lead_id", 0);
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("uo_razbor").insert(rows.slice(i, i + 200));
    if (error) throw new Error("Запись в базу: " + error.message);
  }
  await db.from("uo_zapuski").update({
    finished_at: new Date().toISOString(), status: "готово",
    info: { воронка: uo.name, воронка_id: uo.id, этапы: stages, сделок: rows.length },
  }).eq("id", runId);
}

Deno.serve(async () => {
  if (!TOKEN) return Response.json({ error: "Не задан секрет AMO_TOKEN" }, { status: 500 });
  const { data, error } = await db.from("uo_zapuski").insert({}).select("id").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const job = run(data.id).catch(async (e) => {
    await db.from("uo_zapuski").update({ finished_at: new Date().toISOString(), status: "ошибка", info: { ошибка: String(e?.message ?? e) } }).eq("id", data.id);
  });
  EdgeRuntime.waitUntil(job);
  return Response.json({ started: data.id });
});
