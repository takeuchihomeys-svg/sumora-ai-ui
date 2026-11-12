// scripts/lib/script-deepseek-gate.ts — 台本から DeepSeek へ送る画像の申込の門（import するだけで効く）
//
// 2026-11-13 作業員8b（統括役・危ない所の見張り (o)「DeepSeek を呼ぶのに申込の門を通っていない台本 21本」）:
//   竹内さんの決まり（9/26）「申込の間の部分は DeepSeek に渡さず」。台本の画像の読み（readPropertyImage・readPropertyImageDetail・
//   api.deepseek.com を直に）は会話の画像の URL をそのまま送る形で、申込の線（conversations.deepseek_cutoff_at）を見ていなかった
//   （image_details で数えると 9/21 と 10/13 の台本のまとめ読みで、申込の線より後のスタッフの送った画像 約60枚・12会話が DeepSeek で読まれていた）。
//   台本ごとに行の絞りを足す代わりに、共通の入口＝fetch の出口に1か所で門を置く:
//     - DeepSeek（api.deepseek.com・/chat/completions）宛ての本文の画像の URL が「申込の線より後のメッセージの画像」なら送らずに止める
//     - base64 の画像（data:）は出所が分からないので止める（EXAM_ALLOW_DS_BASE64=on の時だけ通す・手元の資料の確かめ用）
//   止める物の一覧は最初の DeepSeek 宛ての呼び出しの時に1回だけ読む（線のある会話だけ・頁で読む）。読めない時は全部止める（安全側）。
import { createClient } from "@supabase/supabase-js";

const DS_HOST_RE = /(^|\.)deepseek\.com$/;

/** 本文の画像の URL（image_url.url・source.url）と base64 の数（純関数） */
export function imagesInBody(body: string): { urls: string[]; base64: number } {
  const urls: string[] = []; let base64 = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const iu = o.image_url as { url?: unknown } | string | undefined;
    const u = typeof iu === "string" ? iu : typeof iu?.url === "string" ? iu.url : null;
    if (u) { if (u.startsWith("data:")) base64++; else urls.push(u); }
    const src = o.source as { type?: string; url?: string } | undefined;
    if (src?.type === "base64") base64++;
    else if (src?.type === "url" && typeof src.url === "string") urls.push(src.url);
    for (const x of Object.values(o)) if (x && typeof x === "object") walk(x);
  };
  try { walk(JSON.parse(body)); } catch { /* JSON でない＝画像なし */ }
  return { urls: [...new Set(urls)], base64 };
}

/** 送ってよいか（純関数）。blocked が null＝一覧が読めなかった → 画像つきは全部止める */
export function gateVerdict(body: string, blocked: ReadonlySet<string> | null, allowBase64: boolean): { ok: boolean; why: string } {
  const im = imagesInBody(body);
  if (!im.urls.length && !im.base64) return { ok: true, why: "" };
  if (im.base64 && !allowBase64) return { ok: false, why: `base64 の画像 ${im.base64}枚（出所が分からない・EXAM_ALLOW_DS_BASE64=on で通す）` };
  if (!blocked) return { ok: false, why: "申込の線の一覧が読めない（安全側で止める）" };
  const hit = im.urls.filter((u) => blocked.has(u));
  return hit.length ? { ok: false, why: `申込の線より後の会話の画像 ${hit.length}枚` } : { ok: true, why: "" };
}

/** 申込の線より後のメッセージの画像の URL（線のある会話だけ・頁で読む） */
async function loadBlocked(): Promise<Set<string> | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const sb = createClient(url, key, { auth: { persistSession: false } });
  try {
    const cuts: Array<{ id: string; deepseek_cutoff_at: string }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("conversations").select("id, deepseek_cutoff_at").not("deepseek_cutoff_at", "is", null).range(from, from + 999);
      if (error) return null;
      cuts.push(...((data ?? []) as typeof cuts)); if ((data ?? []).length < 1000) break;
    }
    const out = new Set<string>();
    for (const c of cuts) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from("messages").select("image_url").eq("conversation_id", c.id).gt("created_at", c.deepseek_cutoff_at).not("image_url", "is", null).range(from, from + 999);
        if (error) return null;
        for (const r of (data ?? []) as Array<{ image_url: string | null }>) if (r.image_url) out.add(r.image_url);
        if ((data ?? []).length < 1000) break;
      }
    }
    return out;
  } catch { return null; }
}

const KEY = Symbol.for("sumora.scriptDeepseekGate");
/** fetch に門を付ける（1回だけ）。import するだけで呼ばれる */
export function installScriptDeepseekGate(): void {
  const g = globalThis as unknown as Record<symbol, unknown> & { fetch: typeof fetch };
  if (g[KEY]) return;
  g[KEY] = true;
  const inner = g.fetch.bind(globalThis);
  let blockedP: Promise<Set<string> | null> | null = null;
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let u: URL | null = null;
    try { u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url); } catch { u = null; }
    if (u && (DS_HOST_RE.test(u.hostname) || /\/chat\/completions$/.test(u.pathname)) && typeof init?.body === "string") {
      blockedP ??= loadBlocked();
      const v = gateVerdict(init.body, await blockedP, String(process.env.EXAM_ALLOW_DS_BASE64 ?? "").trim().toLowerCase() === "on");
      if (!v.ok) {
        console.warn(`[script-deepseek-gate] ⛔ DeepSeek に送らない: ${v.why}`);
        return new Response(JSON.stringify({ error: { type: "application_gate", message: `申込の門: ${v.why}` } }), { status: 403, headers: { "content-type": "application/json" } });
      }
    }
    return inner(input as RequestInfo, init);
  }) as typeof fetch;
}
installScriptDeepseekGate();
