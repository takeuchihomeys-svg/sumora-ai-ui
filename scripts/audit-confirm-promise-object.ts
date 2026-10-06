// scripts/audit-confirm-promise-object.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-confirm-promise-object.ts [--days=180] [--show=30]
//
// 2026-10-06 ⑫ 竹内さん（チンシャン事例）「これ確認したら連絡なので、AIXの確認したがセットされた状態にする…
//   AIXの物件確認したではなくて、確認したの管理会社に確認したの部分からスタッフが確認して送る」
// 実送信で線を引く: こちらの「確認（出来次第ご連絡）させて頂きます」の約束ごとに
//   ① 約束の要件（スタッフの文から／お客様の直前の質問から／読めない）
//   ② その後お客様が返したのがお礼・了承だけか
//   ③ その後スタッフが最初に押した AIX（7日以内）と check_pattern（物件確認した側か 確認した（条件・交渉）側か）
//   ④ 旧の決め方（物件確認の依頼がある時だけ約束の AIX）と新の決め方（要件が条件・設備なら 確認した（条件・交渉）→〈要件〉）
// を並べる。読み取りのみ。出力は会話の文を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
import { classifyStaffTextFacts, fillConfirmObjectFromCustomer, checkPatternForConfirmTopic, isConfirmPartyObject } from "../app/lib/action-ledger";
import { customerRequestedPropertyCheck } from "../app/lib/aix-scene-evidence";
import { analyzeSubstance } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "180"));
const show = Number(arg("show", "30"));
const since = new Date(Date.now() - days * 86400_000).toISOString();

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
type Aix = { conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string; sent_at: string | null };

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

const MGMT_SIDE = (cp: string | null) => !!cp && /^(?:mgmt_|vacate_date|nearby_parking|owner_other)/.test(cp) && cp !== "mgmt_availability";

async function main() {
  const msgs = await pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", since).order("created_at").range(a, b));
  const aix = await pageAll<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at, sent_at").gte("created_at", since).order("created_at").range(a, b));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) ?? []), m]);
  const aixByConv = new Map<string, Aix[]>();
  for (const r of aix) aixByConv.set(r.conversation_id, [...(aixByConv.get(r.conversation_id) ?? []), r]);

  type Row = { conv: string; at: string; from: "staff" | "customer" | "none"; object: string | null; question: string | null; ackAfter: boolean; requested: boolean;
    oldFires: boolean; newFires: boolean; newCp: string | null; pressed: string | null; pressedCp: string | null; textReport: boolean; promise: string; customer: string };
  const rows: Row[] = [];
  for (const [conv, list] of byConv) {
    list.forEach((m, i) => {
      if (m.sender !== "staff" || !m.text) return;
      const fact = classifyStaffTextFacts(m.text, m.created_at).find((e) => e.kind === "confirmation_promised");
      if (!fact) return;
      const staffObj = !isConfirmPartyObject(fact.detail.object);
      fillConfirmObjectFromCustomer(fact, list, i);
      const from: Row["from"] = staffObj ? "staff" : fact.detail.objectFrom === "customer" ? "customer" : "none";
      // 次のお客様の発言（お礼・了承だけか）
      const nextCust = list.slice(i + 1).find((x) => x.sender === "customer");
      const nextStaffBefore = list.slice(i + 1).findIndex((x) => x.sender === "staff");
      const custIdx = list.slice(i + 1).findIndex((x) => x.sender === "customer");
      const ackAfter = !!nextCust && (nextStaffBefore < 0 || custIdx < nextStaffBefore) && analyzeSubstance(nextCust.text ?? "", [nextCust.text ?? ""]).isAckOnly;
      const prior = list.slice(Math.max(0, i - 12), i + 1).map((x) => ({ sender: x.sender, text: x.text }));
      const requested = customerRequestedPropertyCheck({ recentMessages: prior });
      const cp = checkPatternForConfirmTopic(fact.detail.object);
      const oldFires = requested && !/割引|交渉/.test(fact.detail.object ?? "");
      // 新（2026-10-06・質問3「セットする」）: 要件が条件側なら お客様が聞いた／依頼／お礼・了承の番 のどれかで立てる（初期費用＋御見積書の約束は見積書の流れ）
      const estimateFlow = cp === "mgmt_initial_cost" && /見積/.test(m.text);
      const newFires = (!!cp && !estimateFlow && (from === "customer" || requested || ackAfter)) || oldFires;
      const t0 = Date.parse(m.created_at);
      const next = (aixByConv.get(conv) ?? []).find((r) => { const t = Date.parse(r.sent_at ?? r.created_at); return t > t0 && t - t0 <= 7 * 86400_000; });
      let k = i - 1; while (k >= 0 && list[k].sender !== "customer") k--;
      // 7日以内にスタッフが手打ちで確認結果を報告したか（AIX を使わずに）
      const textReport = list.slice(i + 1).some((x) => x.sender === "staff" && Date.parse(x.created_at) - t0 <= 7 * 86400_000
        && classifyStaffTextFacts(x.text ?? "", x.created_at).some((e) => e.kind === "confirmation_reported"));
      rows.push({ conv, at: m.created_at, from, object: fact.detail.object ?? null, question: fact.detail.question ?? null, ackAfter, requested, oldFires, newFires, newCp: newFires ? (cp ?? null) : null,
        pressed: next?.aix_type ?? null, pressedCp: next?.check_pattern ?? null, textReport, promise: m.text.replace(/\n/g, " / ").slice(0, 90), customer: String(list[k]?.text ?? "").replace(/\n/g, " / ").slice(0, 90) });
    });
  }
  const n = rows.length;
  console.log(`=== 確認の約束 ${n}件（${days}日） ===`);
  const by = (f: (r: Row) => string) => { const c: Record<string, number> = {}; for (const r of rows) c[f(r)] = (c[f(r)] ?? 0) + 1; return c; };
  console.log("要件の出どころ:", by((r) => r.from));
  console.log("要件:", by((r) => `${r.from}:${r.object ?? "なし"}`));
  const custMgmt = rows.filter((r) => r.from === "customer" && checkPatternForConfirmTopic(r.object));
  console.log(`\n--- 要件をお客様の質問から読んだ・条件側（新で約束の AIX が立つ）: ${custMgmt.length}件（お礼・了承だけの番 ${custMgmt.filter((r) => r.ackAfter).length}件）`);
  console.log("その後スタッフが最初に押した AIX:", (() => { const c: Record<string, number> = {}; for (const r of custMgmt) { const k = !r.pressed ? "押していない(7日)" : r.pressed !== "property_check_result" ? r.pressed : MGMT_SIDE(r.pressedCp) ? `確認した（条件・交渉）:${r.pressedCp}` : `物件確認した:${r.pressedCp ?? "-"}`; c[k] = (c[k] ?? 0) + 1; } return c; })());
  const sameCp = custMgmt.filter((r) => r.pressed === "property_check_result" && r.pressedCp === r.newCp).length;
  const pressedCheck = custMgmt.filter((r) => r.pressed === "property_check_result").length;
  console.log(`手打ちで確認結果を報告（7日以内）: ${custMgmt.filter((r) => r.textReport).length}件`);
  console.log(`押した 確認系 ${pressedCheck}件のうち ピッカーまで一致 ${sameCp}件`);
  console.log(`旧で約束の AIX が立った: ${custMgmt.filter((r) => r.oldFires).length}件 → 新: ${custMgmt.filter((r) => r.newFires).length}件`);
  console.log("\n--- 実例（お客様の質問から読んだ・条件側）");
  for (const r of custMgmt.slice(-show)) console.log(`${r.at.slice(0, 16)} ${r.object}→${r.newCp} ack=${r.ackAfter ? "Y" : "-"} 押下=${r.pressed ?? "-"}/${r.pressedCp ?? "-"} 手打ち報告=${r.textReport ? "Y" : "-"} | 客「${r.question}」 | 約束「${r.promise.slice(0, 50)}」`);
  // スタッフの文に条件側の要件がある約束（「ペット可能か管理会社に確認させて頂きます」）: 物件確認の依頼が無いと今は約束の AIX が立たない
  const staffMgmt = rows.filter((r) => r.from === "staff" && checkPatternForConfirmTopic(r.object));
  const dist = (list: Row[]) => { const c: Record<string, number> = {}; for (const r of list) { const k = !r.pressed ? (r.textReport ? "手打ちで報告" : "押していない(7日)") : r.pressed !== "property_check_result" ? r.pressed : MGMT_SIDE(r.pressedCp) ? `確認した（条件・交渉）:${r.pressedCp}` : `物件確認した:${r.pressedCp ?? "-"}`; c[k] = (c[k] ?? 0) + 1; } return c; };
  console.log(`
--- スタッフの文に条件側の要件がある約束: ${staffMgmt.length}件（お礼・了承だけの番 ${staffMgmt.filter((r) => r.ackAfter).length}件・旧で約束の AIX ${staffMgmt.filter((r) => r.oldFires).length}件）`);
  console.log("その後:", dist(staffMgmt));
  console.log(`約束の AIX が立つ: 旧 ${staffMgmt.filter((r) => r.oldFires).length}件 → 新 ${staffMgmt.filter((r) => r.newFires).length}件（うち 確認した（条件・交渉）のピッカー付き ${staffMgmt.filter((r) => r.newFires && r.newCp).length}件）`);
  console.log("お礼・了承だけの番のその後:", dist(staffMgmt.filter((r) => r.ackAfter)));
  console.log("ピッカーまで一致（押した確認系のうち）:", staffMgmt.filter((r) => r.pressed === "property_check_result" && r.pressedCp === checkPatternForConfirmTopic(r.object)).length, "/", staffMgmt.filter((r) => r.pressed === "property_check_result").length);

  const noneAck = rows.filter((r) => r.from === "none" && r.ackAfter);
  console.log(`\n--- 要件が読めない約束＋お礼だけ: ${noneAck.length}件（今まで通り・押下:`, (() => { const c: Record<string, number> = {}; for (const r of noneAck) { const k = r.pressed ? `${r.pressed}:${r.pressedCp ?? "-"}` : "なし"; c[k] = (c[k] ?? 0) + 1; } return c; })(), ")");
  for (const r of noneAck.slice(-10)) console.log(`  ${r.at.slice(0, 16)} 客「${r.customer.slice(0, 60)}」 | 約束「${r.promise.slice(0, 60)}」`);
}
main().catch((e) => { console.error(e); process.exit(1); });
