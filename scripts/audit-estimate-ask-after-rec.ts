// 🌟（こちらがオススメした1件）の後に、お客様が初期費用・見積を聞いた時、スタッフが次に押した AIX を数える（読むだけ・LLM なし）
// 2026-10-01 竹内「まだ確かめ切れていない事の3点強化」③ ブレインの揺れ（見積書送る／AIX なし）を直す前に、決定論の線が実送信で引けるかを見る
//
// 場面（estimate-handoff の出来事と同じ考え）:
//   お客様の発言が FOCUSED_ESTIMATE_ASK_RE（見積もりお願い・初期費用いくら 等）で、空き・募集状況の質問（VACANCY_ASK_RE）を含まない
//   その前 7日以内のこちらの最後の物件の発言が 🌟 の1件（物件オススメ・物件確認した）
//   その 🌟 と依頼の間にお客様の物件の画像・URL（持ち込み）が無い
//   引用の有無でも分ける（🌟 を引用して聞いた／引用なし）
// 次の AIX: 依頼から 48時間以内にスタッフが押した最初の AIX（aix_usage_logs）。無ければ「AIX なし」
//
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-ask-after-rec.ts   （DAYS=180）
import { createClient } from "@supabase/supabase-js";
import { FOCUSED_ESTIMATE_ASK_RE, VACANCY_ASK_RE } from "../app/lib/focused-estimate-request";
import { askPointsAtStarredRoom } from "../app/lib/estimate-ask-signal";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();

type Msg = { conversation_id: string; sender: string; text: string | null; image_type: string | null; quoted_message_id: string | null; line_message_id: string | null; created_at: string };

async function main() {
  // お客様の依頼の発言（候補）
  const asks: Msg[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, image_type, quoted_message_id, line_message_id, created_at")
      .eq("sender", "customer").gte("created_at", since).or("text.ilike.%初期費用%,text.ilike.%見積%,text.ilike.%費用%")
      .order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    asks.push(...((data ?? []) as Msg[]));
    if ((data ?? []).length < 1000) break;
  }
  const cand = asks.filter((m) => m.conversation_id !== YUMA && !/^\s*\[画像\]/.test(m.text ?? "") && FOCUSED_ESTIMATE_ASK_RE.test(m.text ?? "") && !VACANCY_ASK_RE.test(m.text ?? ""));
  const tally = new Map<string, Map<string, number>>();
  const add = (k: string, a: string) => { const t = tally.get(k) ?? new Map(); t.set(a, (t.get(a) ?? 0) + 1); tally.set(k, t); };
  const samples: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  for (const a of cand) {
    const t = new Date(a.created_at).getTime();
    const { data: prev } = await sb.from("messages").select("sender, text, image_type, line_message_id, created_at")
      .eq("conversation_id", a.conversation_id).lt("created_at", a.created_at).gte("created_at", new Date(t - 7 * 86400e3).toISOString())
      .order("created_at", { ascending: false }).limit(40);
    const ms = (prev ?? []) as Array<{ sender: string; text: string | null; image_type: string | null; line_message_id: string | null; created_at: string }>;
    const lastStar = ms.find((m) => m.sender !== "customer" && (m.text ?? "").includes("🌟"));
    if (!lastStar) continue;
    const between = ms.filter((m) => m.created_at > lastStar.created_at);
    // こちらの別の物件の送付（🌟 の後に画像の回など）は除かない＝🌟 が最後の物件の発言である時だけ
    if (between.some((m) => m.sender !== "customer" && /🌟|【[^】]+】/.test(m.text ?? ""))) continue;
    if (between.some((m) => m.sender === "customer" && (["floor_plan", "property_photo", "estimate"].includes(m.image_type ?? "") || /https?:\/\//.test(m.text ?? "")))) continue;
    const key = `${a.conversation_id}|${lastStar.created_at}`;
    if (seen.has(key)) continue; // 同じ 🌟 への依頼は1回
    seen.add(key);
    const quoted = !!a.quoted_message_id;
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", a.conversation_id)
      .gt("created_at", a.created_at).lte("created_at", new Date(t + 48 * 3600e3).toISOString()).order("created_at").limit(1);
    const next = (ax?.[0] as { aix_type?: string } | undefined)?.aix_type ?? "(AIX なし)";
    used++;
    add(quoted ? "引用あり" : "引用なし", next);
    add("全体", next);
    // 決定論の線の候補: 依頼が 🌟 のお部屋を指している（別の建物名・複数の物件を書いていない）
    add(askPointsAtStarredRoom(a.text, lastStar.text) ? "線の内（🌟 のお部屋を指す）" : "線の外（別の名前・複数）", next);
    if (next !== "estimate_sheet" && samples.length < 15) samples.push(`  ${a.created_at.slice(0, 16)} ${a.conversation_id.slice(0, 8)} 次=${next} 依頼「${(a.text ?? "").replace(/\s+/g, " ").slice(0, 50)}」`);
  }
  console.log(`場面（🌟 の後の初期費用・見積の依頼・持ち込みなし）${used}件（${DAYS}日・YUMA 除く）`);
  for (const [k, t] of tally) {
    const n = [...t.values()].reduce((x, y) => x + y, 0);
    console.log(`  ${k} ${n}件: ${[...t].sort((x, y) => y[1] - x[1]).map(([a, c]) => `${a} ${c}（${Math.round((c / n) * 100)}%）`).join("・")}`);
  }
  console.log("見積書送る 以外の例（目で読む）:\n" + samples.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
