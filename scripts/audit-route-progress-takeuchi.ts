// scripts/audit-route-progress-takeuchi.ts — 申込までの地図が竹内さん本人の番でどう見えるか（駅・次の一手の候補・一手の向き・進み）と、申込に届いた会話／届かなかった会話の差を数える
//   読むだけ（SELECT）・LLM なし・書き込みなし・費用0。作業員R・2026-11-23・台帳 #608。
//   竹内さん 11/23「ちゃんと申込までの道筋をブレインは理解してちゃんと申込に向かって動くようになっているのか そこの地図の部分ちゃんと把握しているのか」
//
//   番と進み（進んだ・止まった・戻った・離れた・関わりが続く）は作業員L の guideTurnsOf（scripts/lib/guide-measure.ts）を --promise-wait --viewing-wait の形で使う（数え方をそろえる）。
//   その番ごとに、直前のお客様の連投の時刻 T で customer-state・行動台帳を作り直し（T より後の材料は外す）、locateApplyRoute で地図の駅・分かれ道・次の一手の候補を出す
//   （scripts/audit-apply-route-map.ts と同じ当て方・本番の brain-core と同じ入口の純関数）。
//   申込以降は外す: deal_outcomes の一番早い applied_at（無ければ screening_at）より後の番、と guideTurnsOf の applying の駅。
//   本文は出さない（会話 id の頭8字と数だけ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-route-progress-takeuchi.ts [--days=60] [--max-conv=400] [--json=<出力>]
//   重い読み（会話ごとに customer-state の材料を読む）。JST 9〜22時は --days=2 --max-conv=10 に絞る（--force で外す）。
import { createClient } from "@supabase/supabase-js";
import { sameRouteStation } from "./lib/flex-daily";
import { writeFileSync } from "node:fs";
import { guideTurnsOf, outOfScopeAtOf, type GMsg, type GAix, type GDecision, type GuideTurn } from "./lib/guide-measure";
import { actDirection, routeAgreement, type ActDirection, type Agreement } from "./lib/route-progress";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { resolveCustomerState, type CustomerStateInput } from "../app/lib/customer-state";
import { buildActionLedger } from "../app/lib/action-ledger";
import { routeTypeOf } from "../app/lib/brain-route-type";
import { isAckOnlyTurn } from "../app/lib/ack-topic-scope";
import { sceneEvidenceForTurn } from "../app/lib/brain-aix-feedback";
import { extractCircumstances, validCircumstances, holdFirstReason } from "../app/lib/customer-circumstances";
import { locateApplyRoute, MAIN_ROUTE, ROUTE_NODES, ROUTE_BRANCHES, type ApplyRouteLocation, type RouteNodeId } from "../app/lib/apply-route-map";
import { matchSubstateOf } from "../app/lib/turn-aims-after";
import { SUBSTATES } from "../app/lib/apply-route-substate";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { withRefinedNext, greetingSentTodayOf } from "../app/lib/apply-route-next";
import { farMoveInTurn } from "../app/lib/contact-promise";
import { loadTurnApplicationRecords } from "../app/lib/turn-application-gate-server";
import { turnApplicationReason } from "../app/lib/turn-application-gate";
import { locateAt as locateAtLib } from "./lib/route-locate-at";
const locateAt = (input: CustomerStateInput, T: number, envV2: boolean) => locateAtLib(input, T, envV2, { farMoveIn: FAR_MOVE_IN });
const FAR_MOVE_IN = process.argv.includes("--far-move-in");
// 2026-11-23 作業員A: --first-move（既定なし＝今と同じ）＝竹内さんの一手を「最初の通から2時間以内の AIX」に限る（guide-measure の firstMoveH）。後で時刻で送った AIX は laterAix に分ける
const FIRST_MOVE = process.argv.includes("--first-move");

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const cnt = (a: string[]) => { const m: Record<string, number> = {}; for (const v of a) m[v] = (m[v] ?? 0) + 1; return Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("・"); };

/** 2026-11-23 作業員A（#657）: 番の前の30日に送った AIX の種類ごとの一番新しい時刻（送った時＝sent_at が無ければ created_at） */
function sentBeforeOf(aix: ReadonlyArray<GAix>, T: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const x of aix) {
    const at = x.sent_at ?? x.created_at; const k = String(x.aix_type ?? "").split("/")[0];
    if (!k || !at) continue; const t = Date.parse(at);
    if (!(t < T && T - t <= 30 * 86_400_000)) continue;
    if (!out[k] || out[k] < at) out[k] = at;
  }
  return out;
}

type Row = {
  conv: string; at: string; reached: boolean; node: RouteNodeId | null; branch: string | null; digestNode: RouteNodeId | null; act: string;
  dir: ActDirection | null; agree: Agreement; agree2: Agreement; rule2: string | null; agree3: Agreement; rule3: string | null; agree4: Agreement; rule4: string | null; laterAix: string | null; rt: string | null; detail: string | null; outcome: GuideTurn["outcome"]; after: RouteNodeId | null; sub1: string | null; sub2: string | null; subAt1: boolean | null; subAt2: boolean | null; nextAix: string[]; afterBranch?: string | null; sentBefore?: Record<string, string>; promiseWait?: GuideTurn["promiseWait"];
};

(async () => {
  let days = Number(arg("days", "60")) || 60, maxConv = Number(arg("max-conv", "400")) || 400;
  const h = (new Date().getUTCHours() + 9) % 24;
  // 2026-11-23 作業員A: --convs=<会話の頭8字,…> の時は、その会話だけを会話ごとに読む（全件の読みをしない＝昼でも日数を絞らない）
  const CONVS = arg("convs", "").split(",").map((x) => x.trim()).filter(Boolean);
  if (h >= 9 && h < 22 && !process.argv.includes("--force") && !CONVS.length) { days = Math.min(days, 2); maxConv = Math.min(maxConv, 10); console.log(`営業時間なので --days=${days} --max-conv=${maxConv} に絞った`); }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const skip = new Set<string>(TEST_CONVERSATION_IDS);
  let convs: string[];
  if (CONVS.length) {
    convs = [];
    for (const p of CONVS) { const { data } = await sb.from("conversations").select("id").like("id", `${p}%`).limit(1); const id = (data?.[0] as { id?: string } | undefined)?.id; if (id && !skip.has(id)) convs.push(id); }
  } else {
    const { data: tk, error } = await sb.from("messages").select("conversation_id").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).limit(20000);
    if (error) throw new Error(error.message);
    convs = [...new Set(((tk ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !skip.has(c)).slice(0, maxConv);
  }
  const rows: Row[] = [];
  let convDone = 0, cutPost = 0, failed = 0, timedSkip = 0;
  for (const c of convs) {
    const [m, a, d, deals, a30] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(2000),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).limit(500),
      sb.from("brain_decision_logs").select("created_at, digest").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(1000),
      sb.from("deal_outcomes").select("applied_at, screening_at").eq("conversation_id", c),
      // 2026-11-23 作業員A（#657）: 「今どこ」の読み違いの元＝番の前の30日に送った AIX（窓の始めより前も読む・guideTurnsOf には渡さない）
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", new Date(Date.parse(since) - 30 * 86_400_000).toISOString()).limit(1000),
    ]);
    const decisions: GDecision[] = ((d.data ?? []) as Array<{ created_at: string; digest: { sg?: string; cp?: string } | null }>).map((x) => ({ created_at: x.created_at, stage: x.digest?.sg ?? x.digest?.cp ?? null }));
    const turns = guideTurnsOf(c, (m.data ?? []) as GMsg[], (a.data ?? []) as GAix[], decisions, 48, { promiseWait: true, viewingWait: true, ...(FIRST_MOVE ? { firstMoveH: 2 } : {}) });
    const appliedAts = ((deals.data ?? []) as Array<{ applied_at: string | null; screening_at: string | null }>).map((x) => x.applied_at ?? x.screening_at).filter((x): x is string => !!x).map((x) => Date.parse(x)).sort((x, y) => x - y);
    const firstApplied = appliedAts[0] ?? Infinity;
    const reached = appliedAts.length > 0;
    // 2026-11-23 作業員A（R の台本の持ち主・統括役の決め・q038／8590144d）: 申込の記録で引く門（記入済みの申込フォーム・証明書類・書類の印の通・成約の記録）も通す。
    //   旧は deal_outcomes の applied_at／screening_at だけで、申込の書類が先に届いた会話（8590144d は 9/24 01:27 にフォーム）の後の番を数えていた
    const gateRec = await loadTurnApplicationRecords(sb as never, c);
    // 2026-11-24 作業員A: 仮抑え・提携会社への引き継ぎの後の番も外す（申込以降と同じ・guide-measure.outOfScopeAtOf）
    const outAt = outOfScopeAtOf((m.data ?? []) as GMsg[]);
    const outMs = outAt ? Date.parse(outAt) : Infinity;
    const pre = turns.filter((t) => Date.parse(t.at) < firstApplied && Date.parse(t.at) < outMs && !turnApplicationReason(gateRec, t.at));
    cutPost += turns.length - pre.length;
    if (!pre.length) continue;
    let input: CustomerStateInput | null = null;
    try { input = await loadCustomerStateInput(c); } catch { input = null; }
    if (!input) { failed++; continue; }
    convDone++;
    for (const t of pre) {
      const tAt = Date.parse(t.at);
      const lastCust = [...input.messages].reverse().find((x) => x.sender === "customer" && Date.parse(x.createdAt) < tAt);
      if (!lastCust) continue;
      // 2026-11-25 作業員A（#687・統括役の頼み「番の時刻が AIX の送信と重なる番を外す」）: 竹内さんの一手が、お客様の通の後の別の日に時刻で送った
      //   AIX【当日のご挨拶】（内覧の日の朝に送る物）の番は、お客様の通への一手ではない（3db9db75 10/24: 一手の時刻＝ご挨拶の送信・お客様の通は前の日）＝外して別に数える。止める --keep-timed
      { const jd = (ms: number) => Math.floor((ms + 9 * 3_600_000) / 86_400_000); if (!process.argv.includes("--keep-timed") && /greeting_viewing/.test(String(t.act ?? "")) && jd(tAt) !== jd(Date.parse(lastCust.createdAt))) { timedSkip++; continue; } }
      const T = Date.parse(lastCust.createdAt) + 1000;
      let r: ReturnType<typeof locateAt>;
      try { r = locateAt(input, T, false); } catch { continue; }
      // 2026-11-23 作業員A（P の地図の進み・route:progress_60d と毎朝の route:station:<駅>:progress）: 分かれ道の番は、竹内さんの一手の後の
      //   お客様の返事（48時間以内・連投の最後）の時点で地図をもう一度当て、分かれ道が閉じたか（afterBranch＝その時の分かれ道・閉じたら null）を残す。
      //   返事が無い番・分かれ道でない番は欄を付けない（undefined）＝「本線に戻った」と数えない
      let afterBranch: string | null | undefined;
      if (r.loc.branch) {
        const nx = input.messages.find((x) => x.sender === "customer" && Date.parse(x.createdAt) > tAt && Date.parse(x.createdAt) - tAt <= 48 * 3600_000);
        if (nx) {
          let k = input.messages.indexOf(nx);
          while (k + 1 < input.messages.length && input.messages[k + 1].sender === "customer") k++;
          try { afterBranch = locateAt(input, Date.parse(input.messages[k].createdAt) + 1000, false).loc.branch ?? null; } catch { afterBranch = undefined; }
        }
      }
      const s1 = r.sub1 ? SUBSTATES.find((x) => x.id === r.sub1) : null, s2 = r.sub2 ? SUBSTATES.find((x) => x.id === r.sub2) : null;
      const atOk = (s: typeof s1) => (s ? s.at === r.loc.node || s.at === r.loc.branch : null);
      rows.push({
        conv: c.slice(0, 8), at: t.at, reached, node: r.loc.node, branch: r.loc.branch, digestNode: t.before, act: t.act,
        dir: actDirection(r.loc.node, t.act), agree: routeAgreement(r.loc, t.act), agree2: routeAgreement(r.loc2, t.act), rule2: r.loc2.evidence.find((e) => e.startsWith("次の一手を番で選び直し:"))?.split(":")[1] ?? null,
        agree3: routeAgreement(r.loc3, t.act), rule3: r.loc3.evidence.find((e) => e.startsWith("次の一手を番で選び直し:"))?.split(":")[1] ?? null, agree4: routeAgreement(r.loc4, t.act), rule4: r.loc4.evidence.find((e) => e.startsWith("次の一手を番で選び直し:"))?.split(":")[1] ?? null, laterAix: t.laterAix ? `${t.laterAix}@${t.laterAixH}h` : null, rt: r.rt, detail: r.detail, outcome: t.outcome, after: t.after,
        sub1: r.sub1, sub2: r.sub2, subAt1: atOk(s1), subAt2: atOk(s2), nextAix: r.loc.next?.aix ?? [],
        ...(afterBranch !== undefined ? { afterBranch } : {}),
        sentBefore: sentBeforeOf(((a30.data ?? []) as GAix[]), T),
        ...(t.promiseWait ? { promiseWait: t.promiseWait } : {}), // 2026-11-24 作業員A: こちらの約束待ちを駅の数で分ける（route-station-trust.our_wait）
      });
    }
  }
  const N = rows.length;
  const nm = (n: RouteNodeId | null) => (n ? ROUTE_NODES[n].name : "不明");
  console.log(`■ 申込までの地図 × 竹内さん本人の番（${days}日・会話 ${convs.length}→測った ${convDone}・読めない ${failed}・申込以降で外した番 ${cutPost}・番 ${N}・申込に届いた会話の番 ${rows.filter((r) => r.reached).length}）`);
  console.log(`  別の日に時刻で送った当日のご挨拶の番（お客様の通への一手でない・外した）: ${timedSkip}（--keep-timed で入れる）`);
  console.log(`\n## A 位置: 地図の駅 ${cnt(rows.map((r) => nm(r.node)))}`);
  console.log(`   分かれ道: ${cnt(rows.map((r) => (r.branch ? ROUTE_BRANCHES[r.branch as keyof typeof ROUTE_BRANCHES].name : "なし")))}`);
  const both = rows.filter((r) => r.node && r.digestNode);
  console.log(`   地図の駅（作り直し）と判断の記録の段（digest.sg）が同じ: ${both.filter((r) => r.node === r.digestNode || (r.node === "hearing" && r.digestNode === "pickup")).length}/${both.length}（${pct(both.filter((r) => r.node === r.digestNode || (r.node === "hearing" && r.digestNode === "pickup")).length, both.length)}）・段の記録が無い番 ${rows.filter((r) => !r.digestNode).length}`);
  {
    // 2026-11-23 #620 の原因: digest.sg は 11/03 05:41Z から。それより前の判断の記録は cp（ブレインの5段 hearing/proposing/viewing/applying/contract）だけで、
    //   guide-measure は sg が無いと cp で駅を出す＝ピックアップ・気に入った・見積が全部 proposing、内覧調整・予定・後が全部 viewing_arrange になる（数え方）。時代で分けて比べる
    const SG_FROM = "2026-11-03T05:42";
    const CP5: Record<string, string> = { inquiry: "hearing", hearing: "hearing", pickup: "proposing", proposing: "proposing", interested: "proposing", estimate: "proposing", viewing_arrange: "viewing", viewing_scheduled: "viewing", viewed: "viewing", apply_prep: "applying", applying: "applying" };
    const sameSt = (x: Row) => sameRouteStation(x.node, x.digestNode); // 2026-11-25 作業員A: flex-daily と同じ決め（初回で条件まで書いた番の inquiry≈hearing を含む）
    const bt = rows.filter((x) => x.node && x.digestNode), sgE = bt.filter((x) => x.at >= SG_FROM), cpE = bt.filter((x) => x.at < SG_FROM);
    console.log(`   時代で分けた一致: sg の時代（11/03〜）${sgE.filter(sameSt).length}/${sgE.length}・cp の時代（〜11/03・5段に寄せて）${cpE.filter((x) => CP5[x.node!] === CP5[x.digestNode!]).length}/${cpE.length}（駅のままだと ${cpE.filter(sameSt).length}）`);
  }
  console.log(`\n## B 地図の次の一手の候補 vs 竹内さんの一手: ${cnt(rows.map((r) => r.agree))}`);
  const good = (r: Row) => ["aix_match", "promise_match", "reply_match", "reply_invite"].includes(r.agree);
  console.log(`   合う側（aix_match・promise_match・reply_match・reply_invite）: ${rows.filter(good).length}/${N}（${pct(rows.filter(good).length, N)}）`);
  {
    const g2 = (a: Agreement) => ["aix_match", "promise_match", "reply_match", "reply_invite"].includes(a);
    const ch = rows.filter((r) => r.rule2);
    console.log(`\n## B2 次の一手を番で選び直す（APPLY_ROUTE_NEXT_BY_TURN=on）: 合う側 ${rows.filter((r) => g2(r.agree2)).length}/${N}（${pct(rows.filter((r) => g2(r.agree2)).length, N)}）・選び直した番 ${ch.length}・良くなった ${ch.filter((r) => !g2(r.agree) && g2(r.agree2)).length}・悪くなった ${ch.filter((r) => g2(r.agree) && !g2(r.agree2)).length}`);
    console.log(`   v2 の分け: ${cnt(rows.map((r) => r.agree2))}`);
    for (const rule of [...new Set(ch.map((r) => r.rule2!))]) { const rs = ch.filter((r) => r.rule2 === rule); console.log(`   ${rule}: n=${rs.length} 良くなった ${rs.filter((r) => !g2(r.agree) && g2(r.agree2)).length}・悪くなった ${rs.filter((r) => g2(r.agree) && !g2(r.agree2)).length}・竹内さんの一手 ${cnt(rs.map((r) => r.act))}｜悪くなった番 ${rs.filter((r) => g2(r.agree) && !g2(r.agree2)).map((r) => `${r.conv}@${r.at.slice(5, 16)}:${r.act}`).join(" ")}`); }
    { // 2026-11-23 作業員A: B3 ④の段取りの後のお礼（APPLY_ROUTE_ACK_SETUP_NOT_TODAY=on）を v2 に足した時（v2 と比べる）
      const ch3 = rows.filter((r) => r.rule3 !== r.rule2);
      console.log(`   B3（＋APPLY_ROUTE_ACK_SETUP_NOT_TODAY）: 合う側 ${rows.filter((r) => g2(r.agree3)).length}/${N}・v2 から変わった番 ${ch3.length}・良くなった ${ch3.filter((r) => !g2(r.agree2) && g2(r.agree3)).length}・悪くなった ${ch3.filter((r) => g2(r.agree2) && !g2(r.agree3)).length}｜${ch3.map((r) => `${r.conv}@${r.at.slice(5, 16)}:${r.act}${r.laterAix ? `(後で ${r.laterAix})` : ""}:${r.agree2}→${r.agree3}`).join(" ")}`);
      const ch4 = rows.filter((r) => r.rule4 !== r.rule3);
      console.log(`   B4（＋APPLY_ROUTE_GREETING_SENT_SKIP）: 合う側 ${rows.filter((r) => g2(r.agree4)).length}/${N}・B3 から変わった番 ${ch4.length}・良くなった ${ch4.filter((r) => !g2(r.agree3) && g2(r.agree4)).length}・悪くなった ${ch4.filter((r) => g2(r.agree3) && !g2(r.agree4)).length}｜${ch4.map((r) => `${r.conv}@${r.at.slice(5, 16)}:${r.act}:${r.agree3}→${r.agree4}`).join(" ")}`);
      if (FIRST_MOVE) console.log(`   一手の窓（--first-move・2時間）: 後で送った AIX を一手から外した番 ${rows.filter((r) => r.laterAix).length}｜${cnt(rows.filter((r) => r.laterAix).map((r) => `${r.node}:${r.act}→後で ${String(r.laterAix).split("@")[0]}`)).slice(0, 400)}`);
    }
    console.log(`   残りの外れ（v2）:${cnt(rows.filter((r) => !g2(r.agree2) && r.agree2 !== "no_next").map((r) => `${r.branch ? "分:" + r.branch : r.node}:${r.rt}:${r.agree2}→${r.act}`)).slice(0, 900)}`);
  }
  console.log(`\n## C 駅ごと（位置＝分かれ道があれば分かれ道）: n／合う／竹内さんの一手の向き（前へ・同じ・後ろ・約束・動かさない）／結果（進んだ・続く・止まった・戻った・離れた）`);
  const keyOf = (r: Row) => (r.branch ? `分:${ROUTE_BRANCHES[r.branch as keyof typeof ROUTE_BRANCHES].name}` : nm(r.node));
  const groups = new Map<string, Row[]>(); for (const r of rows) (groups.get(keyOf(r)) ?? groups.set(keyOf(r), []).get(keyOf(r))!).push(r);
  const line = (rs: Row[]) => {
    const f = (d: ActDirection) => rs.filter((r) => r.dir === d).length, o = (x: string) => rs.filter((r) => r.outcome === x).length;
    return `n=${rs.length} 合う ${pct(rs.filter(good).length, rs.length)}｜前へ ${f("forward")}・同じ ${f("same")}・後ろ ${f("back")}・約束 ${f("promise")}・動かさない ${f("hold")}｜進んだ ${o("advanced")}・続く ${o("engaged")}・止まった ${o("stuck")}・戻った ${o("back")}・離れた ${o("left")}`;
  };
  const order = (k: string) => { const i = MAIN_ROUTE.findIndex((n) => ROUTE_NODES[n].name === k); return i < 0 ? 100 + k.length : i; };
  for (const [k, rs] of [...groups.entries()].sort((x, y) => order(x[0]) - order(y[0]))) console.log(`   ${k.padEnd(18)} ${line(rs)}`);
  console.log(`\n## D 申込に届いた会話 vs 届かなかった会話（駅ごと・同じ並び）`);
  for (const [k, rs] of [...groups.entries()].sort((x, y) => order(x[0]) - order(y[0]))) {
    const y = rs.filter((r) => r.reached), n = rs.filter((r) => !r.reached);
    if (rs.length < 4) continue;
    console.log(`   ${k}\n      届いた   ${line(y)}\n      届かない ${line(n)}`);
    console.log(`      竹内さんの一手（届いた）: ${cnt(y.map((r) => r.act)).slice(0, 160)}\n      竹内さんの一手（届かない）: ${cnt(n.map((r) => r.act)).slice(0, 160)}`);
  }
  const conv = new Map<string, Row[]>(); for (const r of rows) (conv.get(r.conv) ?? conv.set(r.conv, []).get(r.conv)!).push(r);
  const maxIdx = (rs: Row[]) => Math.max(-1, ...rs.map((r) => (r.node ? MAIN_ROUTE.indexOf(r.node) : -1)));
  const cy = [...conv.values()].filter((rs) => rs[0].reached), cn = [...conv.values()].filter((rs) => !rs[0].reached);
  const share = (cs: Row[][], f: (r: Row) => boolean) => { const all = cs.flat(); return pct(all.filter(f).length, all.length); };
  console.log(`\n## E 会話の単位: 届いた ${cy.length}・届かない ${cn.length}`);
  for (const [lab, cs] of [["届いた", cy], ["届かない", cn]] as const) {
    console.log(`   ${lab}: 番の中央 ${cs.map((x) => x.length).sort((a, b) => a - b)[Math.floor(cs.length / 2)] ?? 0}・一番先の駅 ${cnt(cs.map((x) => (maxIdx(x) >= 0 ? ROUTE_NODES[MAIN_ROUTE[maxIdx(x)]].name : "不明")))}`);
    console.log(`      前へ ${share(cs, (r) => r.dir === "forward")}・約束 ${share(cs, (r) => r.dir === "promise")}・動かさない ${share(cs, (r) => r.dir === "hold")}・合う ${share(cs, good)}・進んだ ${share(cs, (r) => r.outcome === "advanced")}・止まった ${share(cs, (r) => r.outcome === "stuck")}・離れた ${share(cs, (r) => r.outcome === "left")}`);
  }
  console.log(`\n## F 駅の中の状態の網（今の網 v1・2版 v2）: 当たった番 v1 ${rows.filter((r) => r.sub1).length}・v2 ${rows.filter((r) => r.sub2).length}／${N}`);
  console.log(`   状態の駅が地図の駅と食い違う（at が node にも branch にも合わない）: v1 ${rows.filter((r) => r.subAt1 === false).length}/${rows.filter((r) => r.sub1).length}・v2 ${rows.filter((r) => r.subAt2 === false).length}/${rows.filter((r) => r.sub2).length}`);
  console.log(`   v2 の食い違いの組（状態→地図の位置）: ${cnt(rows.filter((r) => r.subAt2 === false).map((r) => `${r.sub2}→${keyOf(r)}`)).slice(0, 400)}`);
  console.log(`\n## G 外れの組（地図の候補 → 竹内さんの一手・多い順）`);
  console.log(`   push_missed（地図は AIX で進める・竹内さんは返信で動かさない）: ${cnt(rows.filter((r) => r.agree === "push_missed").map((r) => `${keyOf(r)}:${r.nextAix[0] ?? ""}→${r.act}`)).slice(0, 500)}`);
  console.log(`   other_aix（違う AIX）: ${cnt(rows.filter((r) => r.agree === "other_aix").map((r) => `${keyOf(r)}:${r.nextAix[0] ?? ""}→${r.act}`)).slice(0, 500)}`);
  console.log(`   pushed_off_map（地図は返信・竹内さんは動かした）: ${cnt(rows.filter((r) => r.agree === "pushed_off_map").map((r) => `${keyOf(r)}→${r.act}`)).slice(0, 400)}`);
  console.log(`   抜き取り（会話 id 頭8字・時刻）: ${rows.filter((r) => !good(r) && r.agree !== "no_next").slice(0, 25).map((r) => `${r.conv}@${r.at.slice(5, 16)}`).join(" ")}`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
