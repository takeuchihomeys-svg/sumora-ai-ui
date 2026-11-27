// scripts/audit-search-condition-drift.ts — 拡張に入った条件と、会話でお客様が言った条件のずれを数える（竹内さん 11/27「条件の所をもっとちゃんと読み取れないか」・2026-11-27 作業員A）
//   LLM なし・軽い読み（30日の送った物件の検索の回 → その会話のお客様の通 14日分）。書かない。
//   検索の回: property_pickups（status=sent）の search_conditions.filled（拡張の画面に入った値）を、search_conditions.at ごとに1回とする。
//   ずれの分け（決まった網・言い切らない）:
//     読み落とし   … お客様が言った家賃・間取り・駅が、検索に1つも入っていない（言った物が欄に無い）
//     古い条件     … お客様が後で言い直した値（最後に言った値）が検索に無く、前に言った値が検索に入っている
//     言い方       … 「〜から近い」「〜まで N 分」「〜沿い」「〜周辺」の言い方の起点の駅が、検索の駅・市区に入っていない
//     優先と妥協   … 「できれば・なるべく・理想は・〜でも大丈夫・妥協・最悪」の言葉があるのに、検索は1つの線（上限ちょうど・その間取りだけ）
//   --show で回ごとの行（お客様の名前・本文は出さない・数と語だけ）
//   実行: npx tsx --env-file=.env.local <この台本> [--days=30] [--show]
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30")), show = process.argv.includes("--show");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });

type Filled = { layouts?: string[]; rent_max?: string; rent_min?: string; stations?: string[]; city_codes?: string[]; building_age?: string };
const N = (s: string) => s.normalize("NFKC");
/** お客様の文の家賃（万円）: 「8万」「8.5万円」「80000円」・初期費用・総額の数は除く */
export function rentMentions(t: string): number[] {
  const s = N(t).replace(/初期(?:費用)?[^。\n]{0,12}?\d+(?:\.\d+)?万/g, "").replace(/(?:総額|合計|敷金|礼金|仲介|見積)[^。\n]{0,8}?\d+(?:\.\d+)?万/g, "");
  const out: number[] = [];
  for (const m of s.matchAll(/(\d{1,2}(?:\.\d)?)\s*万/g)) { const v = Number(m[1]); if (v >= 3 && v <= 40) out.push(v); }
  for (const m of s.matchAll(/(\d{2},?\d{3})\s*円/g)) { const v = Number(m[1].replace(",", "")) / 10000; if (v >= 3 && v <= 40) out.push(v); }
  return out;
}
export function layoutMentions(t: string): string[] { return [...new Set((N(t).toUpperCase().match(/[1-4](?:SLDK|LDK|SDK|DK|K)|ワンルーム|1R/g) ?? []).map((x) => (x === "ワンルーム" ? "1R" : x)))]; }
const LOOSE_RE = /できれば|なるべく|出来れば|理想は|理想を言え|でも大丈夫|でも構いません|でもいい|妥協|最悪|譲れ(?:る|ない)|絶対|必須/;
const PHRASE_RE = /([一-龠ァ-ヶぁ-んA-Za-z]{1,8})(?:駅)?(?:から(?:近い|近く|すぐ|徒歩)|まで(?:電車|乗り換え)?(?:で)?\s*\d{1,3}\s*分|沿い|周辺|付近|近辺)/g;

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data: pk, error } = await sb.from("property_pickups").select("conversation_id, property_customer_id, search_conditions, created_at").eq("status", "sent").gte("created_at", since).not("search_conditions", "is", null).limit(2000);
  if (error) throw error;
  const runs = new Map<string, { conv: string; at: string; filled: Filled }>();
  for (const r of (pk ?? []) as Array<{ conversation_id: string | null; search_conditions: { at?: string; filled?: Filled } | null; created_at: string }>) {
    const sc = r.search_conditions; if (!r.conversation_id || !sc?.filled) continue;
    const at = sc.at ?? r.created_at; const k = `${r.conversation_id}@${at.slice(0, 16)}`;
    if (!runs.has(k)) runs.set(k, { conv: r.conversation_id, at, filled: sc.filled });
  }
  const tally = { 回: 0, 言った物あり: 0, 読み落とし: 0, 古い条件: 0, 言い方: 0, 優先と妥協: 0, ずれなし: 0 } as Record<string, number>;
  const byField = { 家賃: 0, 間取り: 0, 駅: 0 } as Record<string, number>;
  for (const run of runs.values()) {
    const { data: ms } = await sb.from("messages").select("text, created_at").eq("conversation_id", run.conv).eq("sender", "customer").lte("created_at", run.at).gte("created_at", new Date(Date.parse(run.at) - 14 * 864e5).toISOString()).order("created_at", { ascending: true }).limit(60);
    const texts = ((ms ?? []) as Array<{ text: string | null }>).map((m) => String(m.text ?? "")).filter((t) => t && !/^\[(?:画像|スタンプ|動画)\]/.test(t));
    tally.回++;
    const f = run.filled, rentMax = Number(f.rent_max ?? "-1") / 10000, layouts = (f.layouts ?? []).map((x) => (x === "ワンルーム" ? "1R" : N(x).toUpperCase()));
    const stations = (f.stations ?? []).map(N), hasCity = (f.city_codes ?? []).length > 0;
    const rents = texts.flatMap((t) => rentMentions(t)), lays = texts.flatMap((t) => layoutMentions(t));
    const phrases = texts.flatMap((t) => [...N(t).matchAll(PHRASE_RE)].map((m) => m[1].replace(/^(?:の|は|が|を|で|に)/, "")));
    if (!rents.length && !lays.length && !phrases.length) continue;
    tally.言った物あり++;
    const tags: string[] = [];
    // 家賃: 最後に言った値が上限から 0.5万より離れる
    if (rents.length && rentMax > 0) {
      const last = rents[rents.length - 1];
      if (Math.abs(last - rentMax) > 0.5 && last > rentMax) { const earlier = rents.slice(0, -1).some((v) => Math.abs(v - rentMax) <= 0.5); tags.push(earlier ? "古い条件" : "読み落とし"); byField.家賃++; }
    }
    if (lays.length && layouts.length) {
      const lastSet = layoutMentions(texts.filter((t) => layoutMentions(t).length).slice(-1)[0] ?? "");
      if (!lastSet.some((x) => layouts.includes(x))) { const earlier = lays.some((x) => layouts.includes(x)); tags.push(earlier ? "古い条件" : "読み落とし"); byField.間取り++; }
    }
    if (phrases.length && !hasCity) {
      const missing = phrases.filter((p) => p.length >= 2 && !stations.some((s) => s.includes(p) || p.includes(s)));
      if (missing.length) { tags.push("言い方"); byField.駅++; }
    }
    if (texts.some((t) => LOOSE_RE.test(t))) tags.push("優先と妥協");
    for (const tg of new Set(tags)) tally[tg]++;
    if (!tags.length) tally.ずれなし++;
    if (show) console.log(`  ${run.conv.slice(0, 8)} ${run.at.slice(0, 10)} 家賃(言った ${rents.slice(-2).join("/") || "-"}・検索 ${rentMax > 0 ? rentMax : "-"}) 間取り(${lays.slice(-3).join("/") || "-"}・${layouts.join("/") || "-"}) 言い方(${[...new Set(phrases)].slice(0, 3).join("/") || "-"}・駅 ${stations.length}${hasCity ? "・市区" : ""}) → ${[...new Set(tags)].join("・") || "ずれなし"}`);
  }
  console.log(JSON.stringify({ 日: DAYS, ...tally, 欄ごと: byField }));
}
main().catch((e) => { console.error(e); process.exit(1); });
