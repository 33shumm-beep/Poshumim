// Какие каналы и виджеты подключены к AmoCRM: нужно, чтобы найти интеграцию МАКС.
// Только чтение: все виджеты, источники и откуда приходили сообщения в чатах за 60 дней.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TOKEN = Deno.env.get("AMO_TOKEN") ?? "";
const DOMAIN = Deno.env.get("AMO_DOMAIN") ?? "macridin";

async function get(path: string) {
  const res = await fetch(`https://${DOMAIN}.amocrm.ru/api/v4/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 204) return {};
  if (!res.ok) return { ошибка: `${res.status} ${path}` };
  return await res.json();
}

Deno.serve(async () => {
  const sources = await get("sources?limit=250");
  const widgets: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const part = (await get(`widgets?limit=250&page=${page}`))?._embedded?.widgets ?? [];
    widgets.push(...part);
    if (part.length < 250) break;
  }
  const since = Math.floor(Date.now() / 1000) - 60 * 86400;
  const origins: Record<string, number> = {};
  for (const type of ["incoming_chat_message", "outgoing_chat_message"]) {
    const ev = (await get(`events?limit=100&filter[type]=${type}&filter[created_at][from]=${since}`))?._embedded?.events ?? [];
    for (const e of ev) {
      const m = e.value_after?.[0]?.message ?? {};
      const key = `${type === "incoming_chat_message" ? "входящее" : "исходящее"}: ${m.origin ?? "?"}`;
      origins[key] = (origins[key] ?? 0) + 1;
    }
  }
  return Response.json({
    источники: (sources?._embedded?.sources ?? []).map((s: any) => ({ имя: s.name, код: s.origin_code })),
    установленные: widgets.filter((w: any) => w.is_active_in_account).map((w: any) => w.code),
    похожие_на_мессенджеры: widgets
      .filter((w: any) => /max|wazzup|radist|whatcrm|pact|chat2desk|i2crm|umnico|wahelp|chatapp|telegram|whats/i.test(`${w.code} ${w.name ?? ""}`))
      .map((w: any) => ({ код: w.code, активен: !!w.is_active_in_account })),
    каналы_сообщений_за_60_дней: origins,
    всего_виджетов_в_ответе: widgets.length,
    ошибки: [sources?.ошибка].filter(Boolean),
  });
});
