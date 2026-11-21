// scripts/audit-appeal-vs-codes.ts — 竹内さんが物件オススメ／ピックアップの文に実際に書いた推しどころと、AIX の推す点（判定の札 reason_codes）の一致を数える（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（台帳 #479「物件ごとの事実・合う点・合わない点・なぜ選んだか」・統括役の頼み）。
//   1件＝竹内さん本人が送った AIX【物件オススメ】【物件ピックアップした】の文（messages.text・staff_writer=takeuchi）と、
//   その文の物件名（aix_usage_logs.property_names か文の🌟の行）に当たる売上サポの行（property_pickups・同じ会話・送った行）の札。
//   推しどころの網（APPEAL_POINTS）: 文の語 → 札の族（設備は判定の札か資料の設備の読み equipment.facts の ok・どちらも決まった計算）。点ごとに
//     両方 … 竹内さんが書き、札にもある／文だけ … 竹内さんが書いたのに札に無い（AIX が持っていない推しどころ）／札だけ … 札にあるのに竹内さんが書かない
//   文・名前は出さない（点ごとの数だけ）。営業時間（JST 9〜22時）は --days=7 まで（30日は22時以降）。
// 実行: npx tsx --env-file=.env.local scripts/audit-appeal-vs-codes.ts [--days=7] [--type=property_recommendation|property_send|all] [--writer=takeuchi|employee|all] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
/** 推しどころ: 文の語 ／ 札の族（正の札だけ） */
export const APPEAL_POINTS: Array<{ key: string; label: string; text: RegExp; code: RegExp; facts?: string[] }> = [
  { key: "initial_cost", label: "初期費用・敷礼0", text: /敷金.{0,3}礼金.{0,3}(?:0|ゼロ|なし|無し)|敷礼(?:0|ゼロ|なし)|初期費用(?:を|が)?(?:抑え|安)/, code: /^(?:ZERO_ZERO_MATCH|INITIAL_COST_.*OK|DEPOSIT_ZERO|KEY_MONEY_ZERO)/ },
  { key: "free_rent", label: "フリーレント", text: /フリーレント/, code: /^FREE_RENT/ },
  { key: "walk", label: "駅近・徒歩", text: /駅(?:近|チカ)|徒歩\s*[0-9０-９]{1,2}\s*分/, code: /^(?:WALK_OK|WALK_.*OK|STATION_)/ },
  { key: "age", label: "築浅・新築", text: /築浅|新築|築[0-9０-９]{1,2}年|新しい/, code: /^(?:BUILDING_AGE_OK|BUILDING_AGE_TEXT_OK|NEW_BUILD)/ },
  { key: "size", label: "広さ・帖数", text: /広[いさめ々]|㎡|平米|[0-9０-９.]+\s*帖|[0-9０-９.]+\s*畳/, code: /^(?:SQM_OK|SQM_.*OK|ROOM_JO_OK|LDK_JO_OK)/ },
  { key: "rent", label: "家賃", text: /家賃|お家賃|賃料/, code: /^RENT_OK/ },
  { key: "move_in", label: "入居時期", text: /即入居|入居可能|ご入居頂け|ご入居いただけ/, code: /^MOVE_IN_OK/ },
  { key: "renovated", label: "リノベ・室内きれい", text: /リノベ|リフォーム|室内(?:綺麗|きれい)|綺麗なお部屋/, code: /RENOVATED/ },
  { key: "autolock", label: "オートロック", text: /オートロック/, code: /^EQUIP_AUTOLOCK.*OK/, facts: ["autolock"] },
  { key: "delivery_box", label: "宅配ボックス", text: /宅配/, code: /^EQUIP_DELIVERY_BOX.*OK/, facts: ["delivery_box"] },
  { key: "washbasin", label: "独立洗面台", text: /独立洗面|洗面台/, code: /^(?:EQUIP_WASHBASIN.*OK|IMAGE_SEPARATE_WASHSTAND_OK)/, facts: ["washbasin"] },
  { key: "bath_toilet", label: "バス・トイレ別", text: /バス.?トイレ別|セパレート/, code: /^(?:EQUIP_BATH_TOILET.*OK|IMAGE_BATH_TOILET_SEPARATE_OK)/, facts: ["bath_toilet"] },
  { key: "laundry_in", label: "室内洗濯機置場", text: /室内洗濯/, code: /^EQUIP_LAUNDRY_IN.*OK/, facts: ["laundry_in"] },
  { key: "bath_dryer", label: "浴室乾燥", text: /浴室乾燥/, code: /^EQUIP_BATH_DRYER.*OK/, facts: ["bath_dryer"] },
  { key: "counter_kitchen", label: "カウンターキッチン", text: /カウンターキッチン|対面キッチン/, code: /^EQUIP_COUNTER_KITCHEN.*OK/, facts: ["counter_kitchen"] },
  { key: "stove", label: "コンロ（2口・ガス）", text: /[2-3２-３二三]口|ガスコンロ/, code: /^EQUIP_(?:BURNER2|BURNER3|GAS_STOVE).*OK/, facts: ["gas_stove","burner2","burner3"] },
  { key: "pet", label: "ペット可", text: /ペット(?:可|相談|OK)/, code: /^(?:EQUIP_PET.*OK|PET_OK)/, facts: ["pet"] },
  { key: "floor", label: "階・眺望", text: /[0-9０-９]{1,2}階|高層|眺望|最上階|角部屋/, code: /^(?:EQUIP_(?:FLOOR2|TOP_FLOOR|CORNER).*OK|IMAGE_FLOOR_2_PLUS_OK|FLOOR_)/, facts: ["floor2","top_floor","corner"] },
  { key: "south", label: "南向き・日当たり", text: /南向き|日当たり/, code: /^(?:EQUIP_SOUTH.*OK|IMAGE_SOUTH_FACING_OK)/, facts: ["south"] },
];
export type PointTally = { both: number; textOnly: number; codeOnly: number };
/** 1件の文と札 → 点ごとの 両方／文だけ／札だけ（純関数） */
export function appealVsCodes(text: string, codes: ReadonlyArray<string>, factsOk: ReadonlySet<string> = new Set()): Record<string, "both" | "textOnly" | "codeOnly" | null> {
  const t = String(text ?? "").normalize("NFKC");
  const out: Record<string, "both" | "textOnly" | "codeOnly" | null> = {};
  for (const p of APPEAL_POINTS) {
    const inText = p.text.test(t), inCode = codes.some((c) => p.code.test(c)) || (p.facts ?? []).some((k) => factsOk.has(k));
    out[p.key] = inText && inCode ? "both" : inText ? "textOnly" : inCode ? "codeOnly" : null;
  }
  return out;
}
const key = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/[\s　・･\-‐ー－【】()（）🌟]/g, "").toLowerCase();

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "7")) || 7;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && days > 7 && !process.argv.includes("--force")) { days = 7; console.log("営業時間なので --days=7 に絞った（30日は22時以降）"); }
  const type = arg("type", "property_recommendation");
  const writer = arg("writer", "takeuchi");
  const since = new Date(Date.now() - days * 864e5).toISOString();
  let q = sb.from("aix_usage_logs").select("conversation_id, aix_type, property_names, line_message_id, sent_at").gte("sent_at", since).not("line_message_id", "is", null).limit(2000);
  q = type === "all" ? q.in("aix_type", ["property_recommendation", "property_send"]) : q.eq("aix_type", type);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const logs = ((data ?? []) as Array<{ conversation_id: string; aix_type: string; property_names: string[] | null; line_message_id: string; sent_at: string }>)
    .filter((l) => !isTestConversation(l.conversation_id) && !isNoLineTestConversation(l.conversation_id));
  const msgs = new Map<string, { text: string | null; staff_writer: string | null }>();
  const ids = logs.map((l) => l.line_message_id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data: m } = await sb.from("messages").select("line_message_id, text, staff_writer").in("line_message_id", ids.slice(i, i + 100));
    for (const x of (m ?? []) as Array<{ line_message_id: string; text: string | null; staff_writer: string | null }>) msgs.set(x.line_message_id, x);
  }
  const t: Record<string, PointTally> = Object.fromEntries(APPEAL_POINTS.map((p) => [p.key, { both: 0, textOnly: 0, codeOnly: 0 }]));
  let n = 0, noRow = 0;
  for (const l of logs) {
    const m = msgs.get(l.line_message_id);
    if (!m || (writer !== "all" && m.staff_writer !== writer) || !m.text) continue;
    const names = (l.property_names ?? []).map(key).filter((x) => x.length >= 3);
    const { data: pr } = await sb.from("property_pickups").select("property_name, room_no, reason_codes, equipment, sent_at").eq("conversation_id", l.conversation_id).eq("status", "sent")
      .gte("sent_at", new Date(Date.parse(l.sent_at) - 3 * 864e5).toISOString()).lte("sent_at", new Date(Date.parse(l.sent_at) + 36e5).toISOString()).limit(30);
    const rows = ((pr ?? []) as Array<{ property_name: string | null; reason_codes: string[] | null; equipment: { facts?: Record<string, { s?: string }> } | null }>).filter((r) => {
      const k = key(r.property_name);
      return names.length ? names.some((x) => x.includes(k) || k.includes(x)) : key(m.text).includes(k) && k.length >= 3;
    });
    if (!rows.length) { noRow++; continue; }
    n++;
    const codes = [...new Set(rows.flatMap((r) => r.reason_codes ?? []))];
    const factsOk = new Set(rows.flatMap((r) => Object.entries(r.equipment?.facts ?? {}).filter(([, v]) => v?.s === "ok").map(([k]) => k)));
    for (const [k, v] of Object.entries(appealVsCodes(m.text, codes, factsOk))) if (v) t[k][v]++;
  }
  console.log(`${writer === "takeuchi" ? "竹内さん" : `書き手 ${writer} `}の${type === "all" ? "物件オススメ・ピックアップ" : type}の文 × 売上サポの札（${days}日）: 合わせた ${n}件・札の行が見つからない ${noRow}件`);
  console.log("  推しどころ             両方 ／ 文だけ（札に無い）／ 札だけ（書かない）");
  for (const p of APPEAL_POINTS) { const c = t[p.key]; if (c.both + c.textOnly + c.codeOnly) console.log(`  ${p.label.padEnd(14)} ${c.both} ／ ${c.textOnly} ／ ${c.codeOnly}`); }
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify({ days, type, n, noRow, points: t }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
