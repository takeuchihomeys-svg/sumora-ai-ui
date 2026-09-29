// scripts/audit-wants-itemized.ts — お客様の細かい要望（ガスコンロ・カウンターキッチン・リビング○帖以上・初期費用○円以内 等）の抜けの監査（読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-wants-itemized.ts [--days=180] [--show=3] [--out=x.json]
//
// 2026-09-29 竹内「AIXツールのお客さんの条件に反映する部分で抜けが無いか見て、1つ1つ分かりやすく。抜けがないように調査して行う」
// 見る物（お客様の名前・電話は出さない。会話 ID は先頭8文字だけ）:
//   ① 直近 N 日のお客様の発言（messages.sender=customer）と正式フォーマットの原文（raw_format_text）に要望の語があるお客様の数
//   ② そのうち 条件の欄（preferences・ng_points・other_requests・additional_conditions）にその語が入っている数（入っていない＝読み取りの抜け）
//   ③ 欄に入っている人のうち、項目（customer-wants.itemizeWants）に分かれている数（分かれていない＝自由文の塊）
//   ④ 項目に採点の札（scoring）がある数 ⑤ 拡張の検索の入力に効く数
//   ⑥ 自由文の塊（1つの欄に 3節以上・25字以上の節）の数と実例
//   ⑦ 既存の自由文の移行の案（routeChanges: 設備→preferences／NG→ng_points に動く節の数と実例）＝DB には書かない
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import { itemizeWants, routeChanges, splitWantText, AUDIT_WANT_WORDS, type WantsCustomerLike } from "../app/lib/customer-wants";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "180"));
const SHOW = Number(arg("show", "3"));
const OUT = arg("out");
const YUMA_CUSTOMER = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";

type Cust = WantsCustomerLike & { id: string; raw_format_text?: string | null; updated_at?: string | null };
async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let a = 0; ; a += 1000) { const { data, error } = await q(a, a + 999); if (error) throw new Error(error.message); out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
/** 物件の貼り付け（ポータルの OCR）は発言ではない */
const PASTE_RE = /^\s*\[画像\]|間取り[:：]\s*\d|万円\/管理費|築年(?:数|月)[:：]/;

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const custs = (await all<Cust>((a, b) => sb.from("property_customers")
    .select("id, preferences, ng_points, other_requests, additional_conditions, raw_format_text, initial_cost_limit, floor_area_min, building_age, walk_minutes, pet, structure_types, floor_plan, layout, updated_at")
    .gte("updated_at", since).range(a, b) as never)).filter((c) => c.id !== YUMA_CUSTOMER);
  const convs = await all<{ id: string; property_customer_id: string }>((a, b) => sb.from("conversations").select("id, property_customer_id").in("property_customer_id", custs.map((c) => c.id)).range(a, b) as never);
  const custOfConv = new Map(convs.map((c) => [c.id, c.property_customer_id]));
  const said = new Map<string, string[]>();
  for (const ids of chunks(convs.map((c) => c.id), 50)) {
    const rows = await all<{ conversation_id: string; text: string | null }>((a, b) => sb.from("messages").select("conversation_id, text").in("conversation_id", ids).eq("sender", "customer").gte("created_at", since).range(a, b) as never);
    for (const r of rows) {
      if (!r.text || PASTE_RE.test(r.text)) continue;
      const cid = custOfConv.get(r.conversation_id); if (!cid) continue;
      said.set(cid, [...(said.get(cid) ?? []), r.text]);
    }
  }
  console.log(`お客様 ${custs.length}人（${DAYS}日・YUMA 除く）・発言のある人 ${said.size}人・会話 ${convs.length}`);

  const condText = (c: Cust) => [c.preferences, c.ng_points, c.other_requests, c.additional_conditions].map((s) => String(s ?? "")).join("\n").normalize("NFKC");
  const rows: Array<Record<string, unknown>> = [];
  const examples: Record<string, string[]> = {};
  for (const w of AUDIT_WANT_WORDS) {
    let mentioned = 0, inField = 0, itemized = 0, scored = 0, searched = 0;
    const missEx: string[] = [], lumpEx: string[] = [];
    for (const c of custs) {
      const spoken = [...(said.get(c.id) ?? []), String(c.raw_format_text ?? "")].join("\n").normalize("NFKC");
      // 初期費用○万以内は列（initial_cost_limit）に入っていれば「欄にある」（9/29: 旧は文の欄だけを見て、列が入っている 7人も「読み取りの抜け」に数えていた）
      const inCond = w.re.test(condText(c)) || (w.key === "other:initial_cost" && typeof c.initial_cost_limit === "number" && c.initial_cost_limit > 0);
      const inSpoken = w.re.test(spoken);
      if (!inCond && !inSpoken) continue;
      mentioned++;
      if (!inCond) { if (missEx.length < SHOW) missEx.push(sentenceOf(spoken, w.re)); continue; }
      inField++;
      // 列で持つ物（入居時期）は項目にしない（条件の欄のグリッドに出る・採点は MOVE_IN_*）
      if (w.key.startsWith("column:")) { itemized++; scored++; continue; }
      const items = itemizeWants(c);
      // 鍵が「free:」の語（収納）は出所の文で見る（「WIC付き」は設備の equip:walk_in_closet に分かれる＝項目になっている・9/29 に直した）
      const hit = items.find((it) => (w.key.endsWith(":") ? w.re.test(it.source) :it.key === w.key || it.key === `${w.key}:ng` || (w.key === "other:initial_cost" && it.key.startsWith("other:initial_cost"))));
      if (!hit) { if (lumpEx.length < SHOW) lumpEx.push(sentenceOf(condText(c), w.re)); continue; }
      itemized++;
      if (hit.scoring) scored++;
      if (hit.search) searched++;
    }
    rows.push({ 要望の語: w.word, 種類: w.kind, "①言った/書いた": mentioned, "②条件の欄にある": inField, "③項目に分かれる": itemized, "④採点の札": scored, "⑤検索に効く": searched, "欄に無い(読み取りの抜け)": mentioned - inField, "塊のまま": inField - itemized });
    examples[w.word] = [...missEx.map((s) => `欄に無い: ${s}`), ...lumpEx.map((s) => `項目にならない: ${s}`)];
  }
  console.table(rows);
  for (const [word, ex] of Object.entries(examples)) if (ex.length) console.log(`  ${word}: ${ex.join(" ／ ")}`);

  // ⑥ 自由文の塊
  let lumps = 0; const lumpEx: string[] = [];
  for (const c of custs) for (const f of ["preferences", "other_requests", "ng_points"] as const) {
    const v = String(c[f] ?? "");
    const cls = splitWantText(v);
    if (cls.length >= 3 || cls.some((x) => x.length >= 25)) { lumps++; if (lumpEx.length < SHOW * 2) lumpEx.push(`${f}: ${v.replace(/\n/g, "／").slice(0, 80)}`); }
  }
  console.log(`\n⑥ 自由文の塊（3節以上か 25字以上の節がある欄）: ${lumps}欄`);
  for (const e of lumpEx) console.log(`  ${e}`);

  // ⑦ 移行の案（読むだけ）
  const moves: Array<{ from: string; to: string; clause: string }> = [];
  let movedCust = 0;
  for (const c of custs) { const m = routeChanges({ preferences: c.preferences, ng_points: c.ng_points, other_requests: c.other_requests }); if (m.length) { movedCust++; moves.push(...m); } }
  const byRoute = new Map<string, number>();
  for (const m of moves) byRoute.set(`${m.from}→${m.to}`, (byRoute.get(`${m.from}→${m.to}`) ?? 0) + 1);
  console.log(`\n⑦ 既存の自由文の移行の案（DB には書かない）: ${movedCust}人・${moves.length}節`);
  for (const [k, n] of byRoute) console.log(`  ${k}: ${n}節  例: ${moves.filter((m) => `${m.from}→${m.to}` === k).slice(0, SHOW).map((m) => m.clause).join(" ／ ")}`);

  // 全員の項目の集計（採点外の その他 の上位）
  const freeCount = new Map<string, number>();
  let itemsTotal = 0, itemsUnscored = 0;
  for (const c of custs) for (const it of itemizeWants(c)) { itemsTotal++; if (!it.scoring && !it.note) { itemsUnscored++; freeCount.set(it.label, (freeCount.get(it.label) ?? 0) + 1); } }
  console.log(`\n項目 ${itemsTotal}（採点外 ${itemsUnscored}）。採点外の上位:`);
  for (const [l, n] of [...freeCount.entries()].sort((a, z) => z[1] - a[1]).slice(0, 20)) console.log(`  ${n}  ${l}`);

  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ days: DAYS, customers: custs.length, rows, examples, lumps, moves: moves.length, movedCust, byRoute: Object.fromEntries(byRoute), unscoredTop: [...freeCount.entries()].sort((a, z) => z[1] - a[1]).slice(0, 40) }, null, 1), "utf8");
}
function sentenceOf(text: string, re: RegExp): string {
  const s = text.split(/[\n。！？!?]/).find((x) => re.test(x)) ?? "";
  return s.trim().slice(0, 60);
}
main().catch((e) => { console.error(e); process.exit(1); });
