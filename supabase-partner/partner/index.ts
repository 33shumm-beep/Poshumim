// Партнёрская программа КС + ТС (19.10.2026). Публичная функция без JWT, как forma-otchet:
// партнёр ходит по личной ссылке с токеном (#t=...), админка — с ключом «ключ_партнёр_админ» (#a=...).
// В amoCRM ничего не пишет: только ищет клиента по телефону (чтение через шлюз amo).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const otvet = (data: unknown, status = 200) => Response.json(data, { status, headers: CORS });
const sluzh = async (k: string) => (await db.from("sluzhebnoe").select("v").eq("k", k).maybeSingle()).data?.v as string | undefined;
const MENEDZHERY = ["Панченко", "Протасов", "Васильев", "Кудинов"];
// Telegram менеджера лежит в sluzhebnoe под ключом «тг_чат_<id пользователя amo>».
const AMO_ID: Record<string, number> = { Панченко: 7863391, Протасов: 8252290, Васильев: 10467994, Кудинов: 13699338 };
const tekst = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const cifry = (tel: string) => tel.replace(/\D/g, "").slice(-10);
const skryt = (imya: string) => {
  const [a, b] = imya.split(/\s+/);
  return b ? `${a} ${b[0]}.` : a;
};

// Чтение amo через существующий шлюз (запись туда не отправляем никогда).
async function amoGet(path: string, params: Record<string, unknown> = {}) {
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

async function vCrm(tel: string) {
  const r = await amoGet("contacts", { query: cifry(tel), limit: 5 });
  return (r.data?._embedded?.contacts?.length ?? 0) > 0;
}

// Одно сообщение выбранному менеджеру и копия Max (решение Max 28.10). Без повторов и напоминаний.
async function telegram(text: string, menedzher?: string) {
  const token = await sluzh("тг_токен");
  if (!token) return;
  const max = await sluzh("тг_чат");
  const man = menedzher ? await sluzh(`тг_чат_${AMO_ID[menedzher]}`) : undefined;
  const chaty = [...new Set([man, max].filter(Boolean))] as string[];
  await Promise.all(chaty.map((chat) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    }).catch(() => {})
  ));
}

async function partnerPoTokenu(t: unknown) {
  if (typeof t !== "string" || !/^[0-9a-f]{24}$/.test(t)) return null;
  return (await db.from("partnery").select("*").eq("token", t).eq("aktiven", true).maybeSingle()).data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return otvet({ error: "нет" }, 405);
  const b = await req.json().catch(() => ({}));

  // ---------- Админка (Max и Артём) ----------
  if (String(b.action ?? "").startsWith("admin_")) {
    const key = await sluzh("ключ_партнёр_админ");
    if (!key || b.a !== key) return otvet({ error: "Ссылка устарела, попросите новую" }, 403);

    if (b.action === "admin_spisok") {
      const partnery = (await db.from("partnery").select("*").order("id")).data ?? [];
      const peredachi = (await db.from("partner_nachisleno").select("*").order("id", { ascending: false })).data ?? [];
      return otvet({ partnery, peredachi });
    }
    if (b.action === "admin_partner") {
      const row = {
        imya: tekst(b.imya, 80), kompaniya: tekst(b.kompaniya, 120) || null, tip: tekst(b.tip, 40) || null,
        vedet: b.vedet === "Max" ? "Max" : "Артём", telefon: tekst(b.telefon, 30) || null,
        test: b.test === true,
      };
      if (!row.imya) return otvet({ error: "Укажите имя партнёра" }, 400);
      if (b.id) {
        const { error } = await db.from("partnery").update({ ...row, aktiven: b.aktiven !== false }).eq("id", b.id);
        return error ? otvet({ error: "Не сохранилось" }, 500) : otvet({ ok: true });
      }
      const { data, error } = await db.from("partnery").insert(row).select("id, token").single();
      return error ? otvet({ error: "Не сохранилось" }, 500) : otvet({ ok: true, ...data });
    }
    if (b.action === "admin_peredacha") {
      const num = (v: unknown) => (v === "" || v == null ? null : Math.max(0, Math.round(Number(v)) || 0));
      const upd: Record<string, unknown> = {};
      for (const k of ["summa_ks", "summa_ts", "vyplacheno", "amo_lead_id", "amo_lead_ts"]) if (k in b) upd[k] = num(b[k]);
      for (const k of ["avans_ks", "avans_ts", "test"]) if (k in b) upd[k] = b[k] === true;
      if ("kommentariy" in b) upd.kommentariy = tekst(b.kommentariy, 500) || null;
      const { error } = await db.from("partner_peredachi").update(upd).eq("id", b.id);
      return error ? otvet({ error: "Не сохранилось" }, 500) : otvet({ ok: true });
    }
    return otvet({ error: "нет такого действия" }, 400);
  }

  // ---------- Партнёр ----------
  const p = await partnerPoTokenu(b.t);
  if (!p) return otvet({ error: "Ссылка не работает. Позвоните нам: 8 960 660-22-00" }, 403);

  if (b.action === "info") return otvet({ imya: p.imya, kompaniya: p.kompaniya });

  if (b.action === "peredat") {
    // Партнёр выбирает менеджера; направление следует из менеджера (Кудинов ведёт «Тихие стены»).
    const menedzher = MENEDZHERY.includes(b.menedzher) ? b.menedzher : null;
    if (!menedzher) return otvet({ error: "Выберите менеджера" }, 400);
    const napravlenie = menedzher === "Кудинов" ? "ТС" : "КС";
    const imya = tekst(b.imya, 80), tel = tekst(b.tel, 30);
    if (!imya) return otvet({ error: "Напишите ФИО клиента" }, 400);
    if (cifry(tel).length !== 10) return otvet({ error: "Проверьте телефон клиента" }, 400);
    if (b.soglasie !== true) return otvet({ error: "Нужно согласие клиента на звонок" }, 400);

    // Кто первым передал, того и клиент.
    const ranee = (await db.from("partner_peredachi").select("id, partner_id, klient_tel").eq("test", false)).data
      ?.find((r) => cifry(r.klient_tel) === cifry(tel));
    if (ranee && ranee.partner_id !== p.id) {
      return otvet({ error: "Этого клиента уже передали раньше. Если это ошибка, позвоните нам." }, 409);
    }
    if (ranee) return otvet({ error: "Вы уже передавали этого клиента, он есть в списке «Мои клиенты»." }, 409);

    let uzhe: boolean | null = null;
    try { uzhe = await vCrm(tel); } catch { uzhe = null; }
    const row = {
      partner_id: p.id, napravlenie, klient_imya: imya, klient_tel: tel,
      chto_nuzhno: tekst(b.chto, 500) || null, rayon: tekst(b.rayon, 120) || null,
      soglasie: true, uzhe_v_crm: uzhe, test: p.test === true, menedzher,
      etap_ks: napravlenie === "ТС" ? null : "Передан", etap_ts: napravlenie === "КС" ? null : "Передан",
    };
    const { error } = await db.from("partner_peredachi").insert(row);
    if (error) return otvet({ error: "Не сохранилось, попробуйте ещё раз" }, 500);

    const kuda = { КС: "ремонт Капиталстрой", ТС: "Тихие стены", Оба: "ремонт + Тихие стены" }[napravlenie as "КС"];
    await telegram(
      `${p.test ? "[ТЕСТ] " : ""}Новый клиент от партнёра\n` +
      `Партнёр: ${p.imya}${p.kompaniya ? ", " + p.kompaniya : ""} (ведёт ${p.vedet})\n` +
      `Клиент: ${imya}, ${tel}\nМенеджер: ${menedzher}\nНужно: ${kuda}${row.chto_nuzhno ? "\n" + row.chto_nuzhno : ""}${row.rayon ? "\nРайон: " + row.rayon : ""}\n` +
      (uzhe ? "⚠ Этот телефон уже есть в amoCRM, проверьте сделку.\n" : "") +
      `Заведите сделку с источником «Партнёр» и позвоните клиенту.`,
      p.test ? undefined : menedzher, // тестовые заявки менеджерам не уходят
    );
    return otvet({
      ok: true,
      soobshchenie: uzhe
        ? "Клиент записан. Он уже обращался к нам раньше, менеджер проверит и сообщит Вам."
        : "Клиент записан. Мы позвоним ему сегодня или в ближайший рабочий день.",
    });
  }

  if (b.action === "moi") {
    const spisok = (await db.from("partner_nachisleno").select("*").eq("partner_id", p.id)
      .order("created_at", { ascending: false })).data ?? [];
    return otvet({
      imya: p.imya,
      klienty: spisok.map((r) => ({
        imya: skryt(r.klient_imya), data: r.created_at, napravlenie: r.napravlenie,
        etap_ks: r.etap_ks, etap_ts: r.etap_ts, nachisleno: Number(r.nachisleno) || 0,
        vyplacheno: Number(r.vyplacheno) || 0, obnovleno: r.sinhr_at, menedzher: r.menedzher,
      })),
    });
  }
  return otvet({ error: "нет такого действия" }, 400);
});
