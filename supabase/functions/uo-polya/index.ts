// Разовая настройка AmoCRM по разрешению заказчика: три служебных поля сделки для возврата.
// «Текст возврата» — сюда система кладёт сообщение, Salesbot отправляет его в МАКС.
// «Сегмент возврата» и «Касаний возврата» — чтобы менеджер видел, на каком шаге клиент.
// Создаёт только недостающие поля, ничего не удаляет.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TOKEN = Deno.env.get("AMO_TOKEN") ?? "";
const DOMAIN = Deno.env.get("AMO_DOMAIN") ?? "macridin";
const BASE = `https://${DOMAIN}.amocrm.ru/api/v4/leads/custom_fields`;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const NEED = [
  { name: "Текст возврата", type: "textarea" },
  { name: "Сегмент возврата", type: "text" },
  { name: "Касаний возврата", type: "numeric" },
];

Deno.serve(async () => {
  const existing: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${BASE}?limit=250&page=${page}`, { headers: H });
    if (res.status === 204) break;
    const part = (await res.json())?._embedded?.custom_fields ?? [];
    existing.push(...part);
    if (part.length < 250) break;
  }
  const result: Record<string, number> = {};
  const missing = NEED.filter((n) => {
    const f = existing.find((e) => e.name === n.name);
    if (f) result[n.name] = f.id;
    return !f;
  });
  if (missing.length) {
    const res = await fetch(BASE, { method: "POST", headers: H, body: JSON.stringify(missing) });
    const text = await res.text();
    if (!res.ok) return Response.json({ ошибка: `${res.status}: ${text.slice(0, 400)}` }, { status: 500 });
    for (const f of JSON.parse(text)?._embedded?.custom_fields ?? []) result[f.name] = f.id;
  }
  return Response.json({ поля: result, создано: missing.map((m) => m.name) });
});
