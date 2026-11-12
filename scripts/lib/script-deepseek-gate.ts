// scripts/lib/script-deepseek-gate.ts — 台本から DeepSeek へ送る画像の申込の門（import するだけで効く）
//
// 2026-11-13 作業員8b（統括役・危ない所の見張り (o)「DeepSeek を呼ぶのに申込の門を通っていない台本 21本」）:
//   竹内さんの決まり（9/26）「申込の間の部分は DeepSeek に渡さず、切り替えたところ以降渡せば個人情報防げる」。
//   台本の画像の読み（readPropertyImage・readPropertyImageDetail・api.deepseek.com を直に）は会話の画像の URL をそのまま送り、線を見ていなかった。
//   台本ごとに行の絞りを足す代わりに、共通の入口＝fetch の出口に1か所で門を置く。判定は本番（image-detail-store の ensureImageDetail）と同じ:
//     画像の URL が会話のメッセージなら、その会話の線（loadDeepseekCutoff）より後に送った物だけ通す（isAfterCutoff・申込中＝線なしは通さない）
//     会話のメッセージに無い画像（物件ピックアップの資料・手元の資料）は通す。DB が読めない時は止める（fail-closed）
//     base64 の画像（data:）は出所が分からないので止める（EXAM_ALLOW_DS_BASE64=on の時だけ通す）
//   ※ 11/13 の最初の版（a79ed1d7）は線の向きを逆に読んでいた（線より後を止めていた）。この版で本番と同じ向きに直した
import { createClient } from "@supabase/supabase-js";
import { loadDeepseekCutoff, isAfterCutoff } from "../../app/lib/post-apply";

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

export type UrlVerdict = "ok" | "block" | "unknown";
/** 送ってよいか（純関数）。urlVerdicts: 画像ごとの判定（unknown＝DB が読めない → 止める） */
export function gateVerdict(body: string, urlVerdicts: ReadonlyMap<string, UrlVerdict>, allowBase64: boolean): { ok: boolean; why: string } {
  const im = imagesInBody(body);
  if (!im.urls.length && !im.base64) return { ok: true, why: "" };
  if (im.base64 && !allowBase64) return { ok: false, why: `base64 の画像 ${im.base64}枚（出所が分からない・EXAM_ALLOW_DS_BASE64=on で通す）` };
  const blk = im.urls.filter((u) => urlVerdicts.get(u) === "block"), unk = im.urls.filter((u) => (urlVerdicts.get(u) ?? "unknown") === "unknown");
  if (blk.length) return { ok: false, why: `申込の間（線より前・申込中）の会話の画像 ${blk.length}枚` };
  if (unk.length) return { ok: false, why: `申込の線が読めない画像 ${unk.length}枚（安全側で止める）` };
  return { ok: true, why: "" };
}

/** 画像1枚の判定（純関数）: 会話のメッセージでなければ ok・あれば線より後だけ ok */
export function urlVerdictOf(msgs: ReadonlyArray<{ conversation_id: string; created_at: string }>, cutOf: (conv: string) => Parameters<typeof isAfterCutoff>[1]): UrlVerdict {
  if (!msgs.length) return "ok";
  return msgs.every((m) => isAfterCutoff(m.created_at, cutOf(m.conversation_id))) ? "ok" : "block";
}

let sb: ReturnType<typeof createClient> | null = null;
const cutCache = new Map<string, Awaited<ReturnType<typeof loadDeepseekCutoff>>>();
async function verdictsFor(urls: string[]): Promise<Map<string, UrlVerdict>> {
  const out = new Map<string, UrlVerdict>();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || !urls.length) { for (const u of urls) out.set(u, "unknown"); return out; }
  sb ??= createClient(url, key, { auth: { persistSession: false } });
  try {
    const { data, error } = await sb.from("messages").select("image_url, conversation_id, created_at").in("image_url", urls).limit(1000);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ image_url: string; conversation_id: string; created_at: string }>;
    for (const c of new Set(rows.map((r) => r.conversation_id))) if (!cutCache.has(c)) cutCache.set(c, await loadDeepseekCutoff(sb, c));
    for (const u of urls) out.set(u, urlVerdictOf(rows.filter((r) => r.image_url === u), (c) => cutCache.get(c)));
  } catch { for (const u of urls) out.set(u, "unknown"); }
  return out;
}

const KEY = Symbol.for("sumora.scriptDeepseekGate");
/** fetch に門を付ける（1回だけ）。import するだけで呼ばれる */
export function installScriptDeepseekGate(): void {
  const g = globalThis as unknown as Record<symbol, unknown> & { fetch: typeof fetch };
  if (g[KEY]) return;
  g[KEY] = true;
  const inner = g.fetch.bind(globalThis);
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let u: URL | null = null;
    try { u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url); } catch { u = null; }
    if (u && (DS_HOST_RE.test(u.hostname) || /\/chat\/completions$/.test(u.pathname)) && typeof init?.body === "string") {
      const im = imagesInBody(init.body);
      const v = gateVerdict(init.body, await verdictsFor(im.urls), String(process.env.EXAM_ALLOW_DS_BASE64 ?? "").trim().toLowerCase() === "on");
      if (!v.ok) {
        console.warn(`[script-deepseek-gate] ⛔ DeepSeek に送らない: ${v.why}`);
        return new Response(JSON.stringify({ error: { type: "application_gate", message: `申込の門: ${v.why}` } }), { status: 403, headers: { "content-type": "application/json" } });
      }
    }
    return inner(input as RequestInfo, init);
  }) as typeof fetch;
}
installScriptDeepseekGate();
