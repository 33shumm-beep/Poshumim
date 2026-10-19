// Раз в час: находит в amoCRM сделки клиентов, переданных партнёрами, и обновляет их этап
// для страницы «Мои клиенты». Только чтение amo (через шлюз amo). Без JWT: пускает только с x-shumm-key. Выключить: sluzhebnoe 'партнёр_синхр' = 'нет'.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sluzh = async (k: string) => (await db.from("sluzhebnoe").select("v").eq("k", k).maybeSingle()).data?.v as string | undefined;
const cifry = (tel: string) => tel.replace(/\D/g, "").slice(-10);

const OSN = 5466436, OS = 10520622, UO = 5518450, TS = 10764258;
const KS_VORONKI = [OSN, OS, UO];
// Этапы, которые видит партнёр.
const ETAP_OSN: Record<number, string> = {
  48426634: "Передан", 48426637: "Передан", 48426640: "Связались", 55021342: "Тёплый клиент",
  48427108: "Замер назначен", 48427111: "Замер проведён", 48427114: "Смета готова",
  72488934: "Смета готова", 72488954: "Смета готова", 142: "Договор подписан", 143: "Не сложилось",
};
const ETAP_TS: Record<number, string> = {
  84766362: "Передан", 87672274: "Передан", 89309014: "Связались", 84766366: "Связались",
  87672278: "Замер назначен", 87672282: "Замер проведён", 84766374: "Смета готова", 86500134: "Смета готова",
  84766370: "Отложил", 88539090: "Передан представителю бренда", 142: "Договор подписан", 143: "Не сложилось",
};
// Этапы Основной, начиная с «Квалифицированна»: клиент уже тёплый.
const TEPLYE = new Set([55021342, 48427108, 48427111, 48427114, 72488934, 72488954, 142]);

async function amoGet(path: string, params: Record<string, unknown> = {}) {
  await sleep(250);
  const res = await fetch(`${URL_}/functions/v1/amo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
      "x-shumm-key": (await sluzh("ключ_функций")) ?? "",
    },
    body: JSON.stringify({ method: "GET", path, params }),
  });
  return (await res.json().catch(() => ({}))) as { status?: number; data?: any };
}

function etapKs(lead: any) {
  if (lead.pipeline_id === OSN) return ETAP_OSN[lead.status_id] ?? "В работе";
  if (lead.pipeline_id === OS) return lead.status_id === 143 ? "Не сложилось" : "Отложил ремонт";
  if (lead.pipeline_id === UO) return lead.status_id === 143 ? "Не сложилось" : "Думает";
  return "В работе";
}
const teplyy = (lead: any) =>
  (lead._embedded?.tags ?? []).some((t: any) => /квалифицирован/i.test(t.name)) ||
  (lead.pipeline_id === OSN && TEPLYE.has(lead.status_id));

Deno.serve(async (req) => {
  const key = await sluzh("ключ_функций");
  if (!key || req.headers.get("x-shumm-key") !== key) return Response.json({ error: "нет доступа" }, { status: 403 });
  if ((await sluzh("партнёр_синхр")) !== "да") return Response.json({ ok: true, vyklyucheno: true });

  const ot = new Date(Date.now() - 200 * 86400000).toISOString();
  const spisok = (await db.from("partner_peredachi").select("*").gte("created_at", ot)).data ?? [];
  let obnovleno = 0;
  for (const p of spisok) {
    const upd: Record<string, unknown> = { sinhr_at: new Date().toISOString() };
    let idKs = p.amo_lead_id as number | null, idTs = p.amo_lead_ts as number | null;

    // Привязка к сделкам по телефону: берём самые свежие сделки контакта в нужных воронках.
    if ((!idKs && p.napravlenie !== "ТС") || (!idTs && p.napravlenie !== "КС")) {
      const c = await amoGet("contacts", { query: cifry(p.klient_tel), with: "leads", limit: 5 });
      const ids = (c.data?._embedded?.contacts ?? []).flatMap((x: any) => (x._embedded?.leads ?? []).map((l: any) => l.id));
      if (ids.length) {
        const params: Record<string, unknown> = { limit: 50 };
        ids.slice(0, 40).forEach((id: number, i: number) => (params[`filter[id][${i}]`] = id));
        const leads = (await amoGet("leads", params)).data?._embedded?.leads ?? [];
        const svezh = (vor: number[]) => leads.filter((l: any) => vor.includes(l.pipeline_id))
          .sort((a: any, b: any) => b.created_at - a.created_at)[0];
        if (!idKs && p.napravlenie !== "ТС") idKs = svezh(KS_VORONKI)?.id ?? null;
        if (!idTs && p.napravlenie !== "КС") idTs = svezh([TS])?.id ?? null;
        if (idKs) upd.amo_lead_id = idKs;
        if (idTs) upd.amo_lead_ts = idTs;
      }
    }
    if (idKs) {
      const l = (await amoGet(`leads/${idKs}`)).data;
      if (l?.id) {
        upd.etap_ks = etapKs(l);
        if (teplyy(l)) upd.teplyy = true;
      }
    }
    if (idTs) {
      const l = (await amoGet(`leads/${idTs}`)).data;
      if (l?.id) upd.etap_ts = l.pipeline_id === TS ? (ETAP_TS[l.status_id] ?? "В работе") : "В работе";
    }
    await db.from("partner_peredachi").update(upd).eq("id", p.id);
    obnovleno++;
  }
  return Response.json({ ok: true, obnovleno });
});
