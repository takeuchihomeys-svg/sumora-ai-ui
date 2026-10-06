// scripts/audit-condition-reach.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-reach.ts [--days=60] [--show=8]
//
// 2026-10-06 ⑫ 竹内さん（R・スモラ）「LINEにしたがって物件検索の条件も変動するように、最新のお客さんが求めている条件で物件検索をできるように、
//   今抜けている部分や、物件検索のブレインが連動できていない部分をみつけて、追加、改善する」
// お客様の LINE の条件の発言が、検索の条件（property_customers の列＝拡張・検索の入力）に届いたかを種類ごとに数える。
//   種類: エリア・家賃・間取り・入居時期・NG・設備（決定論の語で拾う＝取りこぼしはあり得る・見る目安）
//   届いた＝その発言の 1分前〜30分後に、その種類の列の履歴（property_condition_history）がある／既に今の値に入っている
//   物件の問い合わせ（URL・この物件・号室・物件のスクショ）は condition-source-gate で外す（条件の発言として数えない）
// あわせて「物件の問い合わせなのに条件に書いた」（誤って捉えた）を、履歴の根拠の発言（source_message_id）で数える。
// 読み取りのみ。出力は会話の文を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
import { classifyConditionTurn } from "../app/lib/condition-source-gate";
import { placeTokens } from "../app/lib/condition-restore";
import { readConditionStatements, type ConditionStatementKind } from "../app/lib/condition-reading";
import { isFilledSumoraForm } from "../app/lib/condition-format";
import { parseConditionSource } from "../app/lib/condition-history";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "60"));
const show = Number(arg("show", "8"));
const since = new Date(Date.now() - days * 86400_000).toISOString();

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// 2026-10-06: 種類の読み手は app/lib/condition-reading.ts（書き手・ブレインと同じ物）に1つにした
type Kind = ConditionStatementKind;
const FIELDS: Record<Kind, string[]> = {
  エリア: ["desired_area"], 家賃: ["rent_max", "rent_min"], 間取り: ["floor_plan"], 入居時期: ["move_in_time"], NG: ["ng_points"], 設備: ["preferences", "other_requests", "ng_points"],
  通勤: ["commute_station", "commute_minutes"], ペット: ["pet", "preferences", "other_requests"], 徒歩: ["walk_minutes"],
};
const LAYOUT_RE = /(?:^|[^0-9０-９])[1-4１-４]\s?(?:SLDK|LDK|DK|K|R)(?![A-Za-z])|ワンルーム/;
function kindsOf(text: string): Kind[] { return readConditionStatements(text).map((x) => x.kind); }

async function main() {
  type M = { id: string; conversation_id: string; text: string | null; created_at: string };
  const msgs = await pageAll<M>((a, b) => sb.from("messages").select("id, conversation_id, text, created_at").eq("sender", "customer").gte("created_at", since).order("created_at").range(a, b));
  const convs = await pageAll<{ id: string; property_customer_id: string | null; is_post_apply: boolean | null; customer_name: string | null }>((a, b) => sb.from("conversations").select("id, property_customer_id, is_post_apply, customer_name").not("property_customer_id", "is", null).range(a, b));
  const pcOf = new Map(convs.filter((c) => !c.is_post_apply).map((c) => [c.id, c.property_customer_id as string]));
  const hist = await pageAll<{ property_customer_id: string; changed_field: string; old_value: string | null; new_value: string | null; created_at: string; source_message_id: string | null }>((a, b) =>
    sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, created_at, source_message_id").gte("created_at", since).order("created_at").range(a, b));
  const pcs = await pageAll<Record<string, unknown>>((a, b) => sb.from("property_customers").select("id, desired_area, floor_plan, rent_max, move_in_time, ng_points, preferences, other_requests").range(a, b));
  const pcRow = new Map(pcs.map((p) => [String(p.id), p]));
  const histByPc = new Map<string, typeof hist>();
  for (const h of hist) histByPc.set(h.property_customer_id, [...(histByPc.get(h.property_customer_id) ?? []), h]);

  const stat: Record<Kind, { n: number; reached: number; already: number; missed: Array<{ at: string; text: string }> }> = {} as never;
  for (const k of Object.keys(FIELDS) as Kind[]) stat[k] = { n: 0, reached: 0, already: 0, missed: [] };
  let inquiryDropped = 0;
  for (const m of msgs) {
    const pc = pcOf.get(m.conversation_id);
    if (!pc || !m.text || isFilledSumoraForm(m.text) || (m.text.match(/[①②③④⑤⑥⑦⑧]/g) ?? []).length >= 2) continue;
    const turn = classifyConditionTurn(m.text);
    if (!turn.conditionText) { if (turn.kind === "property_inquiry" || turn.kind === "image_property") inquiryDropped++; continue; }
    const ks = kindsOf(m.text);
    if (!ks.length) continue;
    const t = Date.parse(m.created_at);
    const near = (histByPc.get(pc) ?? []).filter((h) => { const x = Date.parse(h.created_at); return x >= t - 60_000 && x <= t + 30 * 60_000; });
    const row = pcRow.get(pc) ?? {};
    for (const k of ks) {
      const s = stat[k];
      s.n++;
      if (near.some((h) => FIELDS[k].includes(h.changed_field))) { s.reached++; continue; }
      // 既に今の値に入っている（言い直し・同じ条件の念押し）
      const cur = FIELDS[k].map((f) => String(row[f] ?? "")).join(" ");
      const already = k === "エリア" ? placeTokens(turn.conditionText).every((p) => cur.includes(p.replace(/(?:駅|方面|周辺|エリア|あたり|辺り)$/, "")))
        : k === "間取り" ? !!turn.conditionText.match(LAYOUT_RE) && cur.includes(String(turn.conditionText.match(LAYOUT_RE)![0]).replace(/^[^0-9１-４]/, "").trim())
        : false;
      if (already) { s.already++; continue; }
      s.missed.push({ at: m.created_at, text: turn.conditionText.replace(/\n/g, " / ").slice(0, 110) });
    }
  }
  console.log(`=== お客様の条件の発言が検索の条件に届いたか（${days}日・申込以降を除く）===`);
  for (const k of Object.keys(FIELDS) as Kind[]) {
    const s = stat[k];
    const miss = s.n - s.reached - s.already;
    console.log(`${k}: 発言 ${s.n} → 列に届いた ${s.reached}・既に入っていた ${s.already}・届いていない ${miss}（${s.n ? Math.round((miss / s.n) * 100) : 0}%）`);
    for (const x of s.missed.slice(-show)) console.log(`    ${x.at.slice(0, 16)} ${x.text}`);
  }
  console.log(`（物件の問い合わせとして入口で外した発言 ${inquiryDropped}通）`);
  // 誤って捉えない: 物件の URL・号室・この物件 を含む発言から条件を読んだ数（0 であるべき）
  let inqWithRead = 0; const inqEx: string[] = [];
  for (const m of msgs) {
    if (!m.text || !/https?:\/\/|号室|この物件|このお部屋/.test(m.text)) continue;
    const rs = readConditionStatements(m.text);
    if (rs.length) { inqWithRead++; inqEx.push(`${rs.map((x) => x.kind).join("・")} | ${m.text.replace(/\n/g, " / ").slice(0, 90)}`); }
  }
  console.log(`（物件の URL・号室・この物件 を含む発言で条件を読んだ: ${inqWithRead}通）`);
  for (const x of inqEx.slice(-show)) console.log("    " + x);

  // 誤って捉えた: 自動の書き手が書いた履歴の根拠の発言が物件の問い合わせ
  const msgById = new Map(msgs.map((m) => [m.id, m]));
  const autoRows = hist.filter((h) => /^(?:p4|path_c|brain_bridge|condition_brain)/.test(String(h.source_message_id ?? "")));
  let withMsg = 0, inquiry = 0;
  const bad: string[] = [];
  for (const h of autoRows) {
    const src = parseConditionSource(h.source_message_id);
    const m = src.messageId ? msgById.get(src.messageId) : undefined;
    if (!m) continue;
    withMsg++;
    const turn = classifyConditionTurn(m.text ?? "");
    if (!turn.conditionText) { inquiry++; bad.push(`${h.created_at.slice(0, 16)} ${src.writer} ${h.changed_field}: ${String(h.old_value ?? "").slice(0, 20)}→${String(h.new_value ?? "").slice(0, 30)} | ${String(m.text ?? "").replace(/\n/g, " / ").slice(0, 70)}`); }
  }
  console.log(`\n=== 自動で書いた履歴 ${autoRows.length}行（根拠の発言が引けた ${withMsg}行）のうち、根拠が物件の問い合わせ・書類だけ: ${inquiry}行 ===`);
  for (const b of bad.slice(-show)) console.log("    " + b);
  // 今回だけ（scope:temporary）で戻した行
  const tempRows = hist.filter((h) => String(h.source_message_id ?? "").startsWith("scope:temporary"));
  console.log(`\n=== ブレインの「今回だけ」で登録の条件を戻した: ${tempRows.length}行 ===`);
  for (const r of tempRows.slice(-show)) console.log(`    ${r.created_at.slice(0, 16)} ${r.changed_field}: ${String(r.old_value ?? "").slice(0, 40)} → ${String(r.new_value ?? "").slice(0, 30)} ${r.source_message_id}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
