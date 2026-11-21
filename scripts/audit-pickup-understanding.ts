// scripts/audit-pickup-understanding.ts — ピックアップで送る物件ごとに、AIX が持っている「物件の理解」の欄の埋まり方を数える（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（竹内さん「物件ピックアップを送るためにも AIX ツールとの連携がかなり重要。AIX ツールが物件をちゃんと理解できればかなり質が高くなる」・統括役の頼み）。
//   元: property_pickups（説明文 summary_text・資料の文字 pdf_text・判定の札 reason_codes・terms・location・equipment・image_analysis・image_facts）。
//   欄ごとに 3つに分ける: 埋まっている（AIX が持つ欄に値がある）／元はあるのに欄が空（資料の文字・画像の読みには値がある＝届いていない）／元も無い。
//   「元はある」の判定は、資料の文字（pdf_text）の語・画像の読み（image_analysis）で決まった計算で見る（言い切れない物は数えない）。
//   文・名前は出さない（欄の数だけ）。--sent は送った行だけ。--json= で欄ごとの数を書く（毎日の数の元）。
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-understanding.ts [--days=30] [--sent] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { parsePropertyFacts } from "../app/lib/property-brain";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = Record<string, unknown> & { conversation_id: string | null; status: string | null; summary_text: string | null; pdf_text: string | null; reason_codes: string[] | null };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const has = (v: unknown) => v != null && v !== "" && !(Array.isArray(v) && !v.length);

export type FieldState = "filled" | "gap" | "none";
export type FieldDef = { key: string; label: string; filled: (r: Row, f: ReturnType<typeof parsePropertyFacts>) => boolean; source?: (r: Row) => boolean };
const pdf = (r: Row) => String(r.pdf_text ?? "");
export const FIELDS: FieldDef[] = [
  { key: "name", label: "名前", filled: (r) => has(r.property_name) },
  { key: "room", label: "号室", filled: (r, f) => has(r.room_no) || has(f.roomNo), source: (r) => /\d{3,4}\s*号室/.test(pdf(r)) },
  { key: "rent", label: "家賃", filled: (_r, f) => f.rentYen != null, source: (r) => /賃料|家賃/.test(pdf(r)) },
  { key: "admin", label: "管理費", filled: (_r, f) => f.adminFeeYen != null, source: (r) => /管理費|共益費/.test(pdf(r)) },
  { key: "plan", label: "間取り", filled: (_r, f) => has(f.floorPlan), source: (r) => /[1-5]\s*S?\s*(?:LDK|DK|K)|ワンルーム/.test(pdf(r)) || has(obj(r.image_analysis).layout) },
  { key: "area", label: "広さ", filled: (_r, f) => f.areaSqm != null, source: (r) => /㎡|m2|平米/.test(pdf(r)) },
  { key: "walk", label: "駅徒歩", filled: (r, f) => f.walkMinutes != null || has(obj(r.location).stations), source: (r) => /徒歩\s*\d/.test(pdf(r)) },
  { key: "age", label: "築年", filled: (r, f) => f.buildingAge != null || has(obj(r.terms).buildingAge) || has(obj(r.terms).builtYear), source: (r) => /築|竣工|建築年/.test(pdf(r)) },
  { key: "equip", label: "設備", filled: (r) => Object.keys(obj(obj(r.equipment).facts)).length > 0, source: (r) => /設備|オートロック|宅配|独立洗面|バス・?トイレ別/.test(pdf(r)) || Object.keys(obj(r.image_facts)).length > 0 },
  { key: "counter_kitchen", label: "カウンターキッチンの有無", filled: (r) => "counter_kitchen" in obj(obj(r.equipment).facts) || (r.reason_codes ?? []).some((c) => /^EQUIP_COUNTER_KITCHEN_/.test(c)), source: (r) => /カウンターキッチン|対面/.test(pdf(r)) || /対面|壁付/.test(String(obj(obj(r.image_analysis).kitchen).type ?? obj(r.image_analysis).kitchen ?? "")) },
  { key: "stove", label: "コンロ（ガス・IH・口数）", filled: (r) => ["gas_stove", "ih", "burner2", "burner3"].some((k) => k in obj(obj(r.equipment).facts)), source: (r) => /ガスコンロ|IH|[2-3２-３二三]口/.test(pdf(r)) || /ガス|IH|口/.test(String(obj(r.image_analysis).kitchen ?? "")) },
  { key: "vacancy", label: "空き・入居時期", filled: (r) => { const k = obj(obj(r.terms).moveIn).kind; return !!k && k !== "unknown"; }, source: (r) => /入居|即入|退去予定|空室/.test(pdf(r)) },
  { key: "initial_cost", label: "初期費用（敷金・礼金）", filled: (r, f) => f.depositMonths != null || f.keyMoneyMonths != null || has(obj(r.terms).deposit) || has(obj(r.terms).keyMoney), source: (r) => /敷金|礼金/.test(pdf(r)) },
  { key: "reasons", label: "推す点・合わない点（判定の札）", filled: (r) => has(r.reason_codes) },
  { key: "fit", label: "お客様の条件との合い方（判定）", filled: (r) => has(r.verdict) },
];
export function fieldStates(r: Row): Record<string, FieldState> {
  const f = parsePropertyFacts(r.summary_text ?? "", null);
  const out: Record<string, FieldState> = {};
  for (const d of FIELDS) out[d.key] = d.filled(r, f) ? "filled" : d.source && d.source(r) ? "gap" : "none";
  return out;
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "30")) || 30, sentOnly = process.argv.includes("--sent");
  const since = new Date(Date.now() - days * 864e5).toISOString();
  let q = sb.from("property_pickups").select("conversation_id, status, property_name, room_no, summary_text, pdf_text, verdict, reason_codes, terms, location, equipment, image_analysis, image_facts").gte("created_at", since).limit(3000);
  if (sentOnly) q = q.eq("status", "sent");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Row[]).filter((r) => r.conversation_id && !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id));
  const t: Record<string, Record<FieldState, number>> = {};
  for (const r of rows) for (const [k, s] of Object.entries(fieldStates(r))) { (t[k] ??= { filled: 0, gap: 0, none: 0 })[s]++; }
  console.log(`物件の理解の欄（${days}日・${sentOnly ? "送った行" : "全部の行"} ${rows.length}行）: 埋まっている／元はあるのに空（届いていない）／元も無い`);
  for (const d of FIELDS) { const c = t[d.key] ?? { filled: 0, gap: 0, none: 0 }; console.log(`  ${d.label.padEnd(14)} ${c.filled} ／ ${c.gap} ／ ${c.none}（埋まり ${rows.length ? Math.round((100 * c.filled) / rows.length) : 0}%）`); }
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify({ days, sentOnly, n: rows.length, fields: t }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
