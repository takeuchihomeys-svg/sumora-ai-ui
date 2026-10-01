// scripts/aix-pairs.ts — AIX の送信を「1通目（AIX の本体）＋続けて送った2通目」の組にし、それぞれ
//   スタッフが書いた（human）／AI の下書きを直した（edited）／ほぼそのまま（as_is）に分ける（読むだけ・監査の共通部品）
//
// 2026-10-01 竹内「物件オススメのところが改善されたように、見積書や他のよく使うAIXテンプレートの部分も改善する」
//   設計知見「『実送信にある』は AI の下書きのまま送った通で数えない」の分け方を全種類で使えるようにした。
//   1通目の下書き … aix_generate_log（生成の時点）＋ ai_reply_examples.ai_draft（aix_action が同じ種類・枝番付きも含む）
//                    ⚠ aix_usage_logs.generated_text は「送った文」（送信時に記録）なので下書きにならない
//                    ⚠ 見積書のカバーレター（sent_reply=ai_draft で送られていない）は除く
//   2通目の下書き … template_selection_logs.adapted_text（AIX テンプレートの ✨ 生成）
//   似ている度（文字の2つ組 Dice）0.97 以上 as_is・0.45 以上 edited・それ未満で下書きがある＝human
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";

export type Origin = "human" | "edited" | "as_is";
export type AixPair = {
  conv: string; at: string;
  first: string; firstOrigin: Origin | null; firstDraft: string;
  second: string | null; secondOrigin: Origin | null; secondDraft: string | null;
};

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type L = { conversation_id: string | null; aix_type: string | null; sent_at: string | null; created_at: string; generated_text: string | null };
type T = { conversation_id: string | null; adapted_text: string | null; created_at: string };

export async function pageAll<X>(build: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<X[]> {
  const out: X[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as X[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const norm = (s: string) => s.replace(/\s+/g, "").replace(/\p{Extended_Pictographic}|️/gu, "");
export function dice(a: string, b: string): number {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(A), gb = grams(B);
  let inter = 0; for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / (Math.max(1, A.length - 1) + Math.max(1, B.length - 1));
}
const originOf = (score: number, flag: boolean | null): Origin => (score >= 0.97 ? "as_is" : score >= 0.45 ? "edited" : flag ? "as_is" : "human");
const isMedia = (t: string) => /^\[(画像|動画|スタンプ|ファイル|音声)/.test(t.trim());

export async function loadAixPairs(sb: SupabaseClient, type: string, sinceIso: string): Promise<{ pairs: AixPair[]; sends: number; noFirst: number }> {
  const logs = (await pageAll<L>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at, created_at, generated_text").eq("aix_type", type).not("sent_at", "is", null).gte("created_at", sinceIso).order("created_at").range(a, b)))
    .filter((l) => l.conversation_id && !isTestConversation(l.conversation_id));
  const convs = [...new Set(logs.map((l) => l.conversation_id!))];
  const msgs: M[] = [];
  for (let i = 0; i < convs.length; i += 80) {
    const chunk = convs.slice(i, i + 80);
    msgs.push(...await pageAll<M>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").in("conversation_id", chunk).gte("created_at", sinceIso).order("conversation_id").order("created_at").range(a, b)));
  }
  const tpl = (await pageAll<T>((a, b) => sb.from("template_selection_logs").select("conversation_id, adapted_text, created_at").gte("created_at", sinceIso).not("adapted_text", "is", null).order("created_at").range(a, b)))
    .filter((t) => t.conversation_id && !isTestConversation(t.conversation_id));
  const gens = await pageAll<{ conversation_id: string | null; generated_text: string | null; created_at: string }>((a, b) => sb.from("aix_generate_log").select("conversation_id, generated_text, created_at").eq("action_type", type).gte("created_at", sinceIso).order("created_at").range(a, b));
  const exs = (await pageAll<{ conversation_id: string | null; ai_draft: string | null; created_at: string; sent_reply: string | null; customer_message: string | null }>((a, b) => sb.from("ai_reply_examples").select("conversation_id, ai_draft, created_at, sent_reply, customer_message").like("aix_action", `${type}%`).not("ai_draft", "is", null).gte("created_at", sinceIso).order("created_at").range(a, b)))
    .filter((e) => (e.customer_message ?? "") !== "（見積書カバーレター）");
  const draftBy = new Map<string, Array<{ text: string; at: number }>>();
  const addD = (c: string | null, t: string | null, at: string) => { if (!c || !t?.trim()) return; if (!draftBy.has(c)) draftBy.set(c, []); draftBy.get(c)!.push({ text: t, at: Date.parse(at) }); };
  for (const g of gens) addD(g.conversation_id, g.generated_text, g.created_at);
  for (const e of exs) addD(e.conversation_id, e.ai_draft, e.created_at);
  const byConv = new Map<string, M[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const tplBy = new Map<string, T[]>();
  for (const t of tpl) { if (!tplBy.has(t.conversation_id!)) tplBy.set(t.conversation_id!, []); tplBy.get(t.conversation_id!)!.push(t); }

  const pairs: AixPair[] = [];
  let noFirst = 0;
  for (const l of logs) {
    const ms = byConv.get(l.conversation_id!) ?? [];
    const sentAt = Date.parse(l.sent_at!);
    const gen = (l.generated_text ?? "").trim();
    // 1通目: 送信の -3分〜+5分 のこちらの文字の発言で、送った文（generated_text）に一番近い物
    let bi = -1, bs = -1;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]; const t = Date.parse(m.created_at);
      if (m.sender !== "staff" || !m.text || isMedia(m.text) || t < sentAt - 180_000 || t > sentAt + 300_000) continue;
      const s = gen ? dice(gen, m.text) : 0;
      if (s > bs) { bs = s; bi = i; }
    }
    if (bi < 0) { noFirst++; continue; }
    const first = ms[bi];
    const fAt = Date.parse(first.created_at);
    // 2通目: 15分以内・お客様の発言が挟まらない最初のこちらの文字の発言
    let second: M | null = null;
    for (let j = bi + 1; j < ms.length; j++) {
      const n = ms[j];
      if (Date.parse(n.created_at) - fAt > 15 * 60_000) break;
      if (n.sender !== "staff") break;
      if (!n.text || isMedia(n.text)) continue;
      second = n; break;
    }
    let secondOrigin: Origin | null = null, secondDraft: string | null = null;
    if (second) {
      const sAt = Date.parse(second.created_at);
      let ts = 0, td: string | null = null;
      for (const t of tplBy.get(l.conversation_id!) ?? []) {
        if (Math.abs(Date.parse(t.created_at) - sAt) > 40 * 60_000) continue;
        const s = dice(t.adapted_text ?? "", second.text!);
        if (s > ts) { ts = s; td = t.adapted_text; }
      }
      secondOrigin = originOf(ts, second.is_aix_generated);
      secondDraft = secondOrigin === "edited" ? td : null;
    }
    // 1通目の出所: 生成の下書き（送信の前 60分以内）で一番近い物。下書きが見つからない＝出所不明（null）
    let ds = 0, dText = "";
    for (const d of draftBy.get(l.conversation_id!) ?? []) {
      if (d.at > fAt + 120_000 || fAt - d.at > 60 * 60_000) continue;
      const s = dice(d.text, first.text!);
      if (s > ds) { ds = s; dText = d.text; }
    }
    const firstOrigin: Origin | null = ds >= 0.97 ? "as_is" : ds >= 0.45 ? "edited" : dText ? "human" : null;
    pairs.push({ conv: l.conversation_id!, at: first.created_at, first: first.text!, firstOrigin, firstDraft: dText || gen,
      second: second?.text ?? null, secondOrigin, secondDraft });
  }
  return { pairs, sends: logs.length, noFirst };
}
