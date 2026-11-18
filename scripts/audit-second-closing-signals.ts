// scripts/audit-second-closing-signals.ts — 竹内さんの2通目の締め（内覧／申込／ご査収）が、何で分かれているかを測る（LLM なし・DB は読むだけ）
//
// 2026-11-18 作業員K（統括役「細かいずれは直しまで」・竹内さん 11/18「そのような細かい部分も改善していくように」）。
//   試験の2通目で、狙う返事の一致は 46%・強さは 48%。見積書の2通目では、今の締めの決め（resolveEstimateClosing）と竹内さん60通の一致は 37%。
//   手元の写し（raw-second-appeal.json・伏せ済み）だけでは分ける手がかりが無かった（お客様の文の「急ぎ」は自動の文が混ざり使えない）。
//   この台本は、本番の締めの決めが読む材料を、送った時点で DB から読み直して並べる:
//     採点（property_pickups・送った時刻より前の行だけ・recommend-cta.appealFromPickup）・今見られるか（recommend-viewable）・
//     内覧済み（AIX 待ち合わせ場所／内覧の挨拶を送った後か・建物名で結ぶ）・お客様の反応（readCustomerReaction）・頼まれた見積（customerAskedEstimate）
//   書き手は messages.staff_writer で竹内さんだけを数える（従業員の回は正解にしない）。
//   出す物: 材料ごとの竹内さんの締めの表／今の決め（見積書は resolveEstimateClosing・物件オススメは resolveRecommendCta）と竹内さんの一致と外れの型。
//
// 実行（DB の読み・JST 22時〜翌9時だけ）:
//   npx tsx --env-file=<exam-night>/.env.local scripts/audit-second-closing-signals.ts --raw=<raw-second-appeal.json> [--md=<出力>]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { appealFromPickup, pickupForFirstMessage, readCustomerReaction, headOfFirstMessage, type PickupLookupRow } from "../app/lib/recommend-cta";
import { resolveRecommendViewable, type ViewableMaterialRow } from "../app/lib/recommend-viewable";
import { estimateAppealOf, estimateHeadOf, estimatePropertiesOf, resolveEstimateClosing } from "../app/lib/estimate-second-message";
import { customerAskedEstimate } from "../app/lib/customer-mindset";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
if (h >= 9 && h < 22 && arg("force") !== "1") { console.error("DB の読みは JST 22時〜翌9時だけ（営業時間は止める）"); process.exit(1); }

type Msg = { sender: string; text: string | null; createdAt?: string; created_at?: string; rawCreatedAt?: string };
type Raw = { src: string; action: string; at: string; sent: string; body: { sentMessage?: string | null; recentMessages?: Msg[] } };
type Close = "viewing" | "apply" | "receipt";
const closeOf = (t: string): Close => /お申込|お部屋(?:を)?抑え|押さえ|並行して審査/.test(t) ? "apply" : /ご案内させて|ご内覧|内覧/.test(t) ? "viewing" : "receipt";
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const cases = (JSON.parse(readFileSync(arg("raw"), "utf8")) as { cases: Raw[] }).cases
    .filter((c) => (c.action === "estimate-second" || c.action.startsWith("rec-second")) && (c.sent ?? "").trim() && c.src);
  // 送った AIX の行 → 会話・書き手
  const conv = new Map<string, string>(); const lmOf = new Map<string, string>();
  for (const ids of chunks(cases.map((c) => c.src), 100)) {
    const { data } = await sb.from("aix_usage_logs").select("id, conversation_id, line_message_id").in("id", ids);
    for (const r of (data ?? []) as Array<{ id: string; conversation_id: string | null; line_message_id: string | null }>) {
      if (r.conversation_id) conv.set(r.id, r.conversation_id);
      if (r.line_message_id) lmOf.set(r.id, r.line_message_id);
    }
  }
  const writer = new Map<string, string>();
  for (const ids of chunks([...new Set(lmOf.values())], 100)) {
    const { data } = await sb.from("messages").select("line_message_id, staff_writer").in("line_message_id", ids);
    for (const r of (data ?? []) as Array<{ line_message_id: string; staff_writer: string | null }>) writer.set(r.line_message_id, String(r.staff_writer ?? ""));
  }
  // 会話ごとの採点の行・内覧の AIX（会話の数だけ・1回ずつ）
  const pickCache = new Map<string, Array<PickupLookupRow & ViewableMaterialRow & { created_at: string }>>();
  const viewCache = new Map<string, Array<{ generated_text: string | null; property_names: string[] | null; created_at: string }>>();
  const tab: Record<string, Record<Close, number>> = {};
  const agree: Record<string, number> = {};
  const miss: string[] = [];
  let n = 0, skippedWriter = 0;
  const add = (k: string, c: Close) => { tab[k] ??= { viewing: 0, apply: 0, receipt: 0 }; tab[k][c]++; };
  for (const c of cases) {
    const lm = lmOf.get(c.src); const w = lm ? writer.get(lm) : undefined;
    if (w !== "takeuchi") { skippedWriter++; continue; }
    const cid = conv.get(c.src); if (!cid) continue;
    const at = Date.parse(c.at);
    if (!pickCache.has(cid)) {
      const { data } = await sb.from("property_pickups").select("property_name, room_no, verdict, reason_codes, created_at, terms").eq("conversation_id", cid).order("created_at", { ascending: false }).limit(300);
      pickCache.set(cid, (data ?? []) as never);
      const { data: v } = await sb.from("aix_usage_logs").select("generated_text, property_names, created_at").eq("conversation_id", cid).in("aix_type", ["meeting_place", "greeting_viewing"]).not("sent_at", "is", null).limit(50);
      viewCache.set(cid, (v ?? []) as never);
    }
    const rows = (pickCache.get(cid) ?? []).filter((r) => Date.parse(r.created_at) <= at);
    const isEst = c.action === "estimate-second";
    const first = c.body.sentMessage ?? "";
    const heads = isEst ? estimatePropertiesOf(first).map(estimateHeadOf).filter((x): x is { name: string; room: string } => !!x) : [headOfFirstMessage(first)].filter((x): x is { name: string; room: string } => !!x);
    const per = heads.map((hd) => { const row = pickupForFirstMessage(rows, hd) as (PickupLookupRow & ViewableMaterialRow) | null; return { found: !!row, appeal: appealFromPickup(row)?.appeal ?? null, notViewable: resolveRecommendViewable({ text: null, material: row, brain: { notViewable: false } }).notViewable }; });
    const ap = estimateAppealOf(per.map(({ appeal, notViewable }) => ({ appeal, notViewable })));
    const found = per.some((p) => p.found);
    const buildings = heads.map((hd) => hd.name).filter((b) => b.length >= 2);
    const viewed = (viewCache.get(cid) ?? []).some((r) => Date.parse(r.created_at) < at && buildings.some((b) => (r.generated_text ?? "").includes(b) || (r.property_names ?? []).some((x) => String(x ?? "").includes(b))));
    const msgs = (c.body.recentMessages ?? []).map((m) => ({ ...m, created_at: m.rawCreatedAt ?? m.createdAt ?? m.created_at }));
    const reaction = readCustomerReaction(msgs as never)?.kind ?? null;
    const asked = customerAskedEstimate(msgs as never, at);
    const t = closeOf(c.sent);
    const scene = isEst ? "見積" : c.action.replace(/^rec-second:/, "");
    n++;
    add(`${scene}｜採点 ${found ? (ap.appeal ?? "読めない") : "行なし"}`, t);
    add(`${scene}｜今見られない ${ap.notViewable ? "はい" : "いいえ"}`, t);
    add(`${scene}｜内覧済み ${viewed ? "はい" : "いいえ"}`, t);
    add(`${scene}｜反応 ${reaction ?? "-"}`, t);
    if (isEst) {
      add(`${scene}｜頼まれた見積 ${asked ? "はい" : "いいえ"}`, t);
      const dec = resolveEstimateClosing({ ctaPreference: null, viewed, reactionKind: reaction, appeal: ap.appeal, notViewable: ap.notViewable, customerAsked: asked });
      const k = dec.closing === t ? "一致" : `外れ 竹内 ${t}／決め ${dec.closing}`;
      agree[k] = (agree[k] ?? 0) + 1;
      if (dec.closing !== t && miss.length < 40) miss.push(`${c.src.slice(0, 8)} 竹内 ${t}／決め ${dec.closing}（${dec.reason}）採点 ${ap.appeal ?? "-"}・見られない ${ap.notViewable}・内覧済み ${viewed}・反応 ${reaction ?? "-"}`);
    }
  }
  const pct = (x: number, y: number) => (y ? `${Math.round((x / y) * 100)}%` : "-");
  const out: string[] = [`## 竹内さんの2通目の締めと材料（${n}通・書き手が竹内さんでない ${skippedWriter} 通は除いた）`, "", "| 材料 | 内覧 | 申込 | ご査収 | 通 |", "|---|---|---|---|---|"];
  for (const [k, v] of Object.entries(tab).sort()) { const s = v.viewing + v.apply + v.receipt; out.push(`| ${k} | ${v.viewing}（${pct(v.viewing, s)}） | ${v.apply}（${pct(v.apply, s)}） | ${v.receipt}（${pct(v.receipt, s)}） | ${s} |`); }
  out.push("", "### 見積書: 今の締めの決め（材料を送った時点で読み直した）と竹内さん", ...Object.entries(agree).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`), "", "### 外れ（先頭40）", ...miss.map((m) => `- ${m}`));
  const text = out.join("\n");
  console.log(text);
  if (arg("md")) writeFileSync(arg("md"), text);
})().catch((e) => { console.error(e); process.exit(1); });
