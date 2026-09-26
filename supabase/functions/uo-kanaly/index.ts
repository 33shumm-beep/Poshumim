// Какие каналы и виджеты подключены к AmoCRM: нужно, чтобы найти интеграцию МАКС.
// Только чтение двух справочников, отдаёт названия и коды.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TOKEN = Deno.env.get("AMO_TOKEN") ?? "";
const DOMAIN = Deno.env.get("AMO_DOMAIN") ?? "macridin";

async function get(path: string) {
  const res = await fetch(`https://${DOMAIN}.amocrm.ru/api/v4/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 204) return {};
  if (!res.ok) return { ошибка: res.status };
  return await res.json();
}

Deno.serve(async () => {
  const sources = await get("sources?limit=250");
  const widgets = await get("widgets?limit=250");
  return Response.json({
    источники: (sources?._embedded?.sources ?? []).map((s: any) => ({ id: s.id, имя: s.name, код: s.origin_code, сервисы: (s.services ?? []).map((x: any) => x.type) })),
    виджеты: (widgets?._embedded?.widgets ?? [])
      .filter((w: any) => w.is_active_in_account || w.settings)
      .map((w: any) => ({ код: w.code, имя: w.name ?? w.description ?? "" })),
    ошибки: [sources?.ошибка, widgets?.ошибка].filter(Boolean),
  });
});
