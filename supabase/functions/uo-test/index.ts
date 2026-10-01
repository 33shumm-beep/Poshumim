// Пробная отправка: создаёт тестовую сделку «ТЕСТ возврат» с контактом заказчика сразу
// в закрытом статусе «Условного отказа» (чтобы не сработали триггеры этапов), кладёт в поле
// «Текст возврата» согласованный текст и запускает на этой сделке указанный Salesbot.
// Затрагивает только созданную тестовую сделку.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("AMO_TOKEN") ?? "";
const DOMAIN = Deno.env.get("AMO_DOMAIN") ?? "macridin";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const UO = 5518450, LOST = 143, FIELD_TEXT = 947395;

async function amo(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://${DOMAIN}.amocrm.ru/api/${path.startsWith("v2/") ? path : "v4/" + path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`AmoCRM ${res.status} на ${method} ${path}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

Deno.serve(async (req) => {
  const { data: key } = await db.from("sluzhebnoe").select("v").eq("k", "ключ_функций").single();
  if (!key || req.headers.get("x-shumm-key") !== key.v) return Response.json({ error: "нет доступа" }, { status: 403 });
  const { phone, bot_id, lead_id } = await req.json();
  if (!/^\+7\d{10}$/.test(String(phone)) || !Number(bot_id)) return Response.json({ error: "нужны phone и bot_id" }, { status: 400 });
  try {
    const { data: t } = await db.from("uo_teksty").select("tekst").eq("prichina", "dorogo").eq("kasanie", 2).eq("status", "согласован").single();
    const text = String(t?.tekst ?? "").replace(/,\s*\{имя\}/g, "");
    let leadId = Number(lead_id) || 0;
    if (!leadId) {
      const created = await amo("POST", "leads/complex", [{
        name: "ТЕСТ возврат", pipeline_id: UO, status_id: LOST,
        _embedded: { contacts: [{ first_name: "ТЕСТ возврат", custom_fields_values: [{ field_code: "PHONE", values: [{ value: phone, enum_code: "MOB" }] }] }] },
      }]);
      leadId = created?.[0]?.id;
    }
    await amo("PATCH", `leads/${leadId}`, { custom_fields_values: [{ field_id: FIELD_TEXT, values: [{ value: text }] }] });
    const run = await amo("POST", "v2/salesbot/run", [{ bot_id: Number(bot_id), entity_id: leadId, entity_type: 2 }]);
    return Response.json({ сделка: leadId, бот: Number(bot_id), запуск: run });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message ?? e) }, { status: 500 });
  }
});
