// scripts/lib/yuma-line-send.ts
// 2026-10-02 竹内「DEEPSEEKで一連の流れを実際にYUMAにLINEで送りまくって、弱い部分あるか見つける…自動で繰り返し続ける」（⑫ の繰り返しの実送信）
//   YUMA（竹内さん本人のテスト用の LINE）へ本番の送信 API で送る部品。宛先の確かめ・LINE の月の上限の確かめ（読むだけ）・本番の再分析が走る文の見分け。
//   ・宛先は送る直前に毎回 DB から読み直す（id・名前「YUMA」・line_user_id が1会話だけ・送信停止なし）。YUMA 以外は例外で止める
//   ・LINE の月の上限は本番のお客様への送信と共有 → 送った後の残りが上限の30%未満、または今月の残りの日に本番が使う見込み
//     （直近14日のスタッフの送信の1日平均×残りの日数）を下回るなら送らない（quotaGate）
//   ・スタッフの宣言（見積書・物件ピックアップ・確認の約束）の文は、本番の送信 API が送った後に YUMA でブレインを分析し直し（Claude）・
//     AIX要対応を登録して売上番長グループへ通知する → 送らない（promiseTriggersBrain で見分けて飛ばす）
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

export const YUMA_ID = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PROD = "https://sumora-ai-ui.vercel.app";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

function prodEnv(key: string): string {
  const e = (process.env[key] ?? "").trim();
  if (e && e !== "invalid") return e;
  const l = readFileSync(".env.prod", "utf8").split(/\r?\n/).find((x) => x.startsWith(`${key}=`)) ?? "";
  return l.slice(key.length + 1).trim().replace(/^"(.*)"$/, "$1");
}
const TOKEN_KEY: Record<string, string> = { sumora: "LINE_SUMORA_CHANNEL_ACCESS_TOKEN", ieyasu: "LINE_IEYASU_CHANNEL_ACCESS_TOKEN", giga: "LINE_GIGA_CHANNEL_ACCESS_TOKEN" };

/** 送る直前の宛先の確かめ（毎回 DB から読み直す）。YUMA 以外なら止める */
export async function verifyYumaDestination(): Promise<{ lineUserId: string; account: string }> {
  const { data, error } = await sb.from("conversations").select("id, customer_name, line_user_id, account, send_blocked_reason").eq("id", YUMA_ID).single();
  if (error || !data) throw new Error(`宛先の会話を読めない: ${error?.message}`);
  const c = data as { id: string; customer_name: string | null; line_user_id: string | null; account: string | null; send_blocked_reason: string | null };
  if (c.id !== YUMA_ID || c.customer_name !== "YUMA" || !c.line_user_id || c.send_blocked_reason) throw new Error(`宛先が YUMA でない／送れない: ${JSON.stringify({ id: c.id, name: c.customer_name, blocked: c.send_blocked_reason })}`);
  const { count } = await sb.from("conversations").select("id", { count: "exact", head: true }).eq("line_user_id", c.line_user_id);
  if (count !== 1) throw new Error(`同じ line_user_id の会話が ${count} 件（YUMA だけのはず）`);
  return { lineUserId: c.line_user_id, account: c.account ?? "sumora" };
}

export type QuotaStatus = { account: string; type: string; limit: number | null; used: number; remaining: number | null; dailyProd: number; daysLeft: number; prodNeed: number; ok: boolean; reason: string };
/** LINE の月の上限（読むだけ: GET quota・quota/consumption）と本番の見込み */
export async function quotaGate(plannedSends: number): Promise<QuotaStatus> {
  const { account } = await verifyYumaDestination();
  const token = prodEnv(TOKEN_KEY[account] ?? TOKEN_KEY.sumora);
  const get = async (p: string) => {
    const r = await fetch(`https://api.line.me/v2/bot/message/${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`LINE ${p} ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  };
  // 2026-10-02: 手元の .env.prod は LINE の鍵が空（Vercel の秘密の値は引けない）→ LINE に聞けない時は「一番小さい有料の上限（5,000）」と
  //   今月のスタッフの送信の行数（1回の push に複数の通があっても1行ずつ数える＝多めの見込み）で、控えめに見積もる
  let type = "", limit: number | null = null, used = 0, estimated = false;
  try {
    const q = await get("quota");
    const c = await get("quota/consumption");
    type = String(q.type ?? "");
    limit = type === "limited" ? Number(q.value) : null;
    used = Number(c.totalUsage ?? 0);
  } catch {
    estimated = true;
    type = "estimated(5000)";
    limit = 5000;
  }
  // 本番の1日の送信の見込み: 直近14日のスタッフの送信（この LINE アカウントの会話・YUMA 以外）。画像も1通に数える
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const ids = new Set<string>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data } = await sb.from("conversations").select("id").eq("account", account).range(from, from + 999);
    const rows = (data ?? []) as Array<{ id: string }>;
    rows.forEach((x) => ids.add(x.id));
    if (rows.length < 1000) break;
  }
  let n = 0;
  for (let from = 0; from < 200_000; from += 1000) {
    const { data } = await sb.from("messages").select("conversation_id").eq("sender", "staff").gte("created_at", since).range(from, from + 999);
    const rows = (data ?? []) as Array<{ conversation_id: string }>;
    n += rows.filter((r) => r.conversation_id !== YUMA_ID && ids.has(r.conversation_id)).length;
    if (rows.length < 1000) break;
  }
  const dailyProd = Math.round(n / 14);
  const now = new Date(Date.now() + 9 * 3600_000); // JST
  if (estimated) {
    // 今月（JST）のスタッフの送信の行（YUMA も含む＝自分の送信も数える）
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 9 * 3600_000).toISOString();
    for (let from = 0; from < 200_000; from += 1000) {
      const { data } = await sb.from("messages").select("conversation_id").eq("sender", "staff").gte("created_at", monthStart).range(from, from + 999);
      const rows = (data ?? []) as Array<{ conversation_id: string }>;
      used += rows.filter((r) => ids.has(r.conversation_id)).length;
      if (rows.length < 1000) break;
    }
  }
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysLeft = Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
  const prodNeed = dailyProd * daysLeft;
  if (limit === null) return { account, type, limit, used, remaining: null, dailyProd, daysLeft, prodNeed, ok: true, reason: "上限なし（none）" };
  const remaining = limit - used;
  const after = remaining - plannedSends;
  const ok = after >= limit * 0.3 && after >= prodNeed;
  return { account, type, limit, used, remaining, dailyProd, daysLeft, prodNeed, ok, reason: ok ? "送ってよい" : `送った後の残り ${after} が 上限の30%（${Math.round(limit * 0.3)}）か本番の見込み（${prodNeed}）を下回る` };
}

/** 本番の送信 API が送った後に YUMA でブレインを分析し直す文（スタッフの宣言）か */
export async function promiseTriggersBrain(text: string): Promise<boolean> {
  const { classifyStaffTextFacts } = await import("../../app/lib/action-ledger");
  return classifyStaffTextFacts(text, null).some((e) => e.status === "promised" && (e.kind === "estimate_declared" || e.kind === "pickup_declared" || e.kind === "confirmation_promised"));
}

/** 本番の送信 API で YUMA に送る（宛先は直前に読み直す） */
export async function sendToYuma(message: string): Promise<{ ok: boolean; status: number; ids: string[]; error?: string; sentAt: string }> {
  const dest = await verifyYumaDestination();
  const sentAt = new Date().toISOString();
  const res = await fetch(`${PROD}/api/send-line-message`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${prodEnv("INTERNAL_API_SECRET")}` },
    body: JSON.stringify({ message, origin: "manual", line_user_id: dest.lineUserId, account: dest.account, conversation_id: YUMA_ID }), signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({})) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
  return { ok: res.ok && !!j.ok, status: res.status, ids: j.sentMessageIds ?? [], error: j.error, sentAt };
}

/** LINE で崩れる・お客様に見せたくない形（送る文そのものを見る） */
export function lineRenderRisks(t: string, allowed: ReadonlyArray<string>): string[] {
  const r: string[] = [];
  if (t.length > 5000) r.push(`5000字超（${t.length}）`);
  if (/\*\*[^*]+\*\*/.test(t)) r.push("Markdown の太字 **");
  if (/^\s{0,3}#{1,4}\s/m.test(t)) r.push("Markdown の見出し #");
  if (/^\s*[-*]\s+/m.test(t)) r.push("Markdown の箇条書き -");
  if (/\r/.test(t)) r.push("\\r");
  if (/\n{3,}/.test(t)) r.push("空行が2つ以上続く");
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t)) r.push("壊れた絵文字");
  if (/<<<|>>>|\[返信不要\]|【[^】]*(?:判定|分析|作業)[^】]*】|\{\{|〇〇|○○/.test(t)) r.push("仕組みの印・作業メモ・未置換");
  // 2026-10-02 ⑫ 2巡目: AIX【内覧調整】の文に JSON の名残（…😊！！","closing":"…"}）が入って届いた
  if (/"[A-Za-z_]+"\s*:\s*"|"\s*,\s*"[A-Za-z_]+"|"\s*\}/.test(t)) r.push("JSON の名残");
  // 2026-10-02 ⑫ 13巡目: 指示の文＋区切り線（「…は書かない。\n\n---\nはい😊！！」）が届いた
  if (/^\s*(?:-{3,}|ー{3,}|―{3,}|—{3,}|={3,})\s*$/m.test(t)) r.push("区切り線（---）");
  if (/(?:は|を)書かない[。.]|と書かない|返信を作成します/.test(t)) r.push("指示・作業の文");
  if (/♀|♂|\u{1F469}/u.test(t)) r.push("性別の絵文字");
  const al = new Set<string>(allowed);
  const oa = [...t.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]).filter((e) => !al.has(e) && /\p{Emoji_Presentation}/u.test(e));
  if (oa.length) r.push(`入れてよい絵文字以外: ${oa.join("")}`);
  if (/[ \t]+\n/.test(t)) r.push("行末の空白");
  return r;
}

/** 送った後に本番が YUMA に書いた記録（自分の送信の時刻以降） */
export async function sideRowsSince(since: string): Promise<Record<string, Array<Record<string, unknown>>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const t of ["sent_facts", "calendar_events", "line_tasks", "aix_action_items", "sent_image_properties"]) {
    const { data } = await sb.from(t).select("*").eq("conversation_id", YUMA_ID).gte("created_at", since).limit(100);
    out[t] = (data ?? []) as Array<Record<string, unknown>>;
  }
  return out;
}
