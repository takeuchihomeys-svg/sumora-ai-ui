// scripts/audit-aix-item-cleanup.ts — AIX要対応（aix_action_items）の片付けの線を本番のデータで引く・当てる（読むだけ）
// 2026-09-27 竹内さん「その方向でおねがい」: 1. 返信の本文で AIX の仕事を済ませたら自動で「済み」 2. お客様が止まった・断ったらブレインが取り下げる
// 判定は app/lib/aix-item-cleanup.ts（staffTextFulfillsAixItem / brainPausedCustomer）。ここはそれを本番に当てるだけ。
//
// ① 本文で済み（AIX の種類ごと）:
//    NEG＝通常の返信の後、次のお客様の発言までにその AIX（物件ピックアップ/オススメは同じ系統）を押した番の返信 → 済みと判定したら誤り
//    POS＝AIX要対応の pending の間の返信で、その後同じ系統の AIX を押さなかった番 → 済みと判定した数が効き目
//    ※ 7月前半まで AIX の本文が AIX の印なしで保存されていた（その本文自体が押した AIX）→ 押下が2分以内で間に AIX の印のメッセージが無い物は外す
//    ※ 返信の後に宣言（確認・ピックアップ・見積書）を送っていた番は、送信の直後の再分析で AIX要対応が登録し直される（send-line-message）→「登録し直し」に分けて出す
// ② ブレインの取り下げ: ブレインが AIX（reply_mode=aix）を出した番ごとに brainPausedCustomer を当て、次のお客様の発言までに同じ AIX を押したか
// ③ 過去の AIX要対応（9/12〜）に当てた前後: いつ「済み」「取り下げ」「登録しない」になるか・その後スタッフが同じ AIX を押した番（誤り）・減る pending の時間
//
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-item-cleanup.ts [--since=2026-05-01] [--show=all|<action>] [--read=40]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { staffTextFulfillsAixItem, brainPausedCustomer } from "../app/lib/aix-item-cleanup";
import { classifyStaffTextFacts } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const SINCE = arg("since", "2026-05-01");
const SHOW = arg("show", "");
const READ = Number(arg("read", "40"));
const ITEMS_SINCE = "2026-09-12";

async function all<T>(table: string, cols: string, build: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const ms = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN);
const jst = (t: number | string) => new Date((typeof t === "number" ? t : ms(t)) + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
const one = (s: unknown, n = 110) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const FAM: Record<string, string> = { property_send: "prop", property_recommendation: "prop", property_send_new_arrival: "prop", property_send_widen: "prop", property_check: "check", property_check_result: "check" };
const fam = (a: string | null | undefined) => (a ? FAM[a] ?? a : "");
const PROMISE_KINDS = new Set(["estimate_declared", "pickup_declared", "confirmation_promised"]);
const hasPromise = (text: string) => classifyStaffTextFacts(text, null).some((e) => e.status === "promised" && PROMISE_KINDS.has(e.kind));
const isMediaOnly = (t: string | null) => !t || /^\[(?:画像|スタンプ|動画|ファイル|位置情報)\]$/.test(t.trim());

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Use = { conversation_id: string; aix_type: string; created_at: string; sent_at: string | null };
type Log = { conversation_id: string; created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; analyzed_msg_ts: string | null; decision_source: string | null; analysis_mode: string | null; digest: Record<string, unknown> | null };
type Item = { id: string; conversation_id: string; customer_name: string | null; action: string; check_pattern: string | null; status: string; brain_analyzed_msg_ts: string | null; created_at: string; updated_at: string; done_at: string | null; done_aix_type: string | null; dismissed_reason: string | null };

async function main() {
  const [msgs, uses, logs, items, convs] = await Promise.all([
    all<Msg>("messages", "conversation_id, sender, text, created_at, is_aix_generated", (q) => q.gte("created_at", SINCE).order("created_at", { ascending: true })),
    all<Use>("aix_usage_logs", "conversation_id, aix_type, created_at, sent_at", (q) => q.gte("created_at", SINCE).order("created_at", { ascending: true })),
    all<Log>("brain_decision_logs", "conversation_id, created_at, suggested_action, suggested_reply_mode, analyzed_msg_ts, decision_source, analysis_mode, digest", (q) => q.gte("created_at", ITEMS_SINCE).order("created_at", { ascending: true })),
    all<Item>("aix_action_items", "id, conversation_id, customer_name, action, check_pattern, status, brain_analyzed_msg_ts, created_at, updated_at, done_at, done_aix_type, dismissed_reason", (q) => q.gte("created_at", ITEMS_SINCE).order("created_at", { ascending: true })),
    all<{ id: string; customer_name: string | null }>("conversations", "id, customer_name", (q) => q.gte("updated_at", SINCE)),
  ]);
  const name = new Map(convs.map((c) => [c.id, c.customer_name ?? "?"]));
  const by = <T extends { conversation_id: string }>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { const k = String(x.conversation_id); (m.get(k) ?? m.set(k, []).get(k)!).push(x); } return m; };
  const M = by(msgs), U = by(uses), L = by(logs);
  console.log(`=== AIX要対応の片付けの監査: メッセージ ${msgs.length}（${SINCE}〜）・押した AIX ${uses.length}・ブレインの判断 ${logs.length}・AIX要対応 ${items.length}（${ITEMS_SINCE}〜） ===`);

  /** 手打ち m の後、次のお客様の発言までに押した AIX（印なし保存の AIX 本文を除く） */
  const pressedAfter = (cid: string, cm: Msg[], i: number) => {
    const m = cm[i];
    const nextCust = cm.slice(i + 1).find((x) => x.sender === "customer");
    const W = nextCust ? ms(nextCust.created_at) : ms(m.created_at) + 7 * 864e5;
    return (U.get(cid) ?? []).filter((u) => {
      const t = ms(u.sent_at ?? u.created_at);
      if (!(t > ms(m.created_at) && t <= W + 90_000)) return false;
      if (t - ms(m.created_at) < 120_000 && !cm.some((x) => x.is_aix_generated && ms(x.created_at) >= ms(m.created_at) && ms(x.created_at) <= t + 120_000)) return false;
      return true;
    }).map((u) => ({ type: u.aix_type, t: ms(u.sent_at ?? u.created_at) }));
  };

  // ── ① 本文で済み ──
  const ACTIONS = ["property_check_result", "acknowledge_check", "estimate_sheet", "meeting_place", "viewing_invite", "application_push", "property_send", "property_recommendation"];
  const neg: Record<string, Array<{ name: string; at: string; text: string; pressed: string; reReg: boolean }>> = {};
  for (const [cid, cm] of M) {
    if (isTestConversation(cid)) continue;
    for (let i = 0; i < cm.length; i++) {
      const m = cm[i];
      if (m.sender !== "staff" || m.is_aix_generated || isMediaOnly(m.text)) continue;
      const pressed = pressedAfter(cid, cm, i);
      for (const a of ACTIONS) {
        const hit = pressed.find((p) => fam(p.type) === fam(a));
        if (!hit) continue;
        // 押す前に宣言を送っていた（この返信自体・その後の手打ち）→ 送信の直後の再分析で登録し直される
        const reReg = cm.some((x) => x.sender === "staff" && !x.is_aix_generated && ms(x.created_at) >= ms(m.created_at) && ms(x.created_at) < hit.t && !!x.text && hasPromise(x.text));
        (neg[a] ??= []).push({ name: name.get(cid) ?? cid.slice(0, 6), at: m.created_at, text: m.text!, pressed: pressed.map((p) => p.type).join(","), reReg });
      }
    }
  }
  const pos: Record<string, Array<{ name: string; at: string; text: string; status: string }>> = {};
  for (const it of items) {
    const cid = String(it.conversation_id);
    if (isTestConversation(cid)) continue;
    const end = it.status === "done" ? ms(it.done_at) : it.status === "dismissed" ? ms(it.updated_at) : Date.now();
    const cm = M.get(cid) ?? [];
    for (let i = 0; i < cm.length; i++) {
      const m = cm[i];
      const t = ms(m.created_at);
      if (t <= ms(it.brain_analyzed_msg_ts) || t > end || m.sender !== "staff" || m.is_aix_generated || isMediaOnly(m.text)) continue;
      if (pressedAfter(cid, cm, i).some((p) => fam(p.type) === fam(it.action))) continue;
      (pos[it.action] ??= []).push({ name: it.customer_name ?? "?", at: m.created_at, text: m.text!, status: `${it.status}/${it.dismissed_reason ?? it.done_aix_type ?? ""}` });
    }
  }
  console.log(`\n■ ① 返信の本文で済み（押した番＝NEG に当てた誤り／AIX要対応の押さなかった番＝POS に当てた効き目）`);
  for (const a of ACTIONS) {
    const P = pos[a] ?? [], N = neg[a] ?? [];
    const judge = (x: { text: string }) => staffTextFulfillsAixItem({ action: a }, x.text);
    const pH = P.filter((x) => judge(x).done), nH = N.filter((x) => judge(x).done);
    const nErr = nH.filter((x) => !x.reReg), nRe = nH.filter((x) => x.reReg);
    console.log(`  ${a}: 押した番の返信 ${N.length} → 済みと判定 ${nH.length}（誤り ${nErr.length}・宣言で登録し直し ${nRe.length}）／押さなかった番の返信 ${P.length} → 済み ${pH.length}`);
    for (const x of nErr) console.log(`     ✗誤り ${x.name} ${jst(x.at)}「${one(x.text)}」→押=${x.pressed}`);
    for (const x of nRe) console.log(`     △登録し直し ${x.name} ${jst(x.at)}「${one(x.text)}」→押=${x.pressed}`);
    if (SHOW === "all" || SHOW === a) for (const x of pH) { const r = judge(x); console.log(`     ○済み ${x.name} ${jst(x.at)} [${r.done ? r.basis : ""}]（${x.status}）「${one(x.text)}」`); }
  }

  // ── ② ブレインの取り下げ ──
  const lastLog = new Map<string, Log>();
  for (const l of logs) { if (isTestConversation(l.conversation_id) || l.analysis_mode === "cached" || !l.analyzed_msg_ts) continue; lastLog.set(`${l.conversation_id}|${l.analyzed_msg_ts}`, l); }
  const metaOf = (l: Log) => ({ action: l.suggested_action, decision_source: l.decision_source, hesitancy_pattern: (l.digest?.hes as string | null | undefined) ?? null, customer_intent: (l.digest?.intent as string | null | undefined) ?? null, source: l.analysis_mode === "cached" ? "cached" : "brain" });
  let aixTurns = 0, pausedTurns = 0, pausedSame = 0, pausedOther = 0;
  const pausedRows: string[] = [];
  for (const l of lastLog.values()) {
    if (!l.suggested_action || l.suggested_reply_mode !== "aix") continue;
    aixTurns++;
    const p = brainPausedCustomer(metaOf(l));
    if (!p.paused) continue;
    pausedTurns++;
    const cid = String(l.conversation_id), cm = M.get(cid) ?? [];
    const turn = [...cm].reverse().find((m) => m.sender === "customer" && ms(m.created_at) <= ms(l.analyzed_msg_ts) + 5000);
    const nextCust = cm.find((m) => m.sender === "customer" && ms(m.created_at) > ms(l.analyzed_msg_ts) + 5000);
    const W = nextCust ? ms(nextCust.created_at) : ms(l.analyzed_msg_ts) + 7 * 864e5;
    const pressed = (U.get(cid) ?? []).filter((u) => { const t = ms(u.sent_at ?? u.created_at); return t > ms(l.analyzed_msg_ts) && t <= W + 90_000; }).map((u) => u.aix_type);
    const same = pressed.some((x) => fam(x) === fam(l.suggested_action));
    if (same) pausedSame++; else if (pressed.length) pausedOther++;
    pausedRows.push(`     ${same ? "✗同じ AIX を押した" : pressed.length ? "・別の AIX" : "・押さず"} ${name.get(cid) ?? cid.slice(0, 6)} ${jst(l.analyzed_msg_ts!)} ${l.suggested_action}（${p.reason}）「${one(turn?.text, 70)}」${pressed.length ? " 押=" + pressed.join(",") : ""}`);
  }
  console.log(`\n■ ② ブレインの取り下げ（brainPausedCustomer）: ブレインが AIX を出した番 ${aixTurns}（${ITEMS_SINCE}〜・保留の型は 9/13〜の digest）→ 取り下げの型 ${pausedTurns}・次の発言までに同じ AIX を押した（誤り）${pausedSame}・別の AIX ${pausedOther}`);
  pausedRows.forEach((x) => console.log(x));

  // ── ③ 過去の AIX要対応に当てた前後 ──
  type Sim = { name: string; action: string; kind: "済み" | "取り下げ" | "登録しない（先に返信で済み）" | "登録しない（保留）"; at: number; basis: string; actualEnd: string; savedMin: number; err: boolean; pressedAfter: string };
  const sims: Sim[] = [];
  let seen = 0;
  for (const it of items) {
    const cid = String(it.conversation_id);
    if (isTestConversation(cid)) continue;
    seen++;
    const cm = M.get(cid) ?? [];
    const turnT = ms(it.brain_analyzed_msg_ts);
    const end = it.status === "done" ? ms(it.done_at) : it.status === "dismissed" ? ms(it.updated_at) : Date.now();
    const actualEnd = it.status === "done" ? `✅${it.done_aix_type ?? ""}` : it.status === "dismissed" ? `取り下げ(${it.dismissed_reason ?? ""})` : "まだ pending";
    let sim: Omit<Sim, "err" | "pressedAfter" | "savedMin"> | null = null;
    // 登録の番の判断が保留（瑞希・🐥・m◡̈⃝e 型）→ 登録しない
    const regLog = [...(L.get(cid) ?? [])].reverse().find((l) => l.analyzed_msg_ts && Math.abs(ms(l.analyzed_msg_ts) - turnT) < 1000 && l.suggested_action === it.action && ms(l.created_at) <= ms(it.created_at) + 60_000 && l.analysis_mode !== "cached");
    if (regLog) { const p = brainPausedCustomer(metaOf(regLog)); if (p.paused) sim = { name: it.customer_name ?? "?", action: it.action, kind: "登録しない（保留）", at: ms(it.created_at), basis: p.reason, actualEnd }; }
    // 登録より前（判断より先に）返信で済ませていた
    if (!sim) {
      const early = cm.find((m) => m.sender === "staff" && !m.is_aix_generated && ms(m.created_at) > turnT && ms(m.created_at) <= ms(it.created_at) && staffTextFulfillsAixItem(it, m.text).done);
      if (early) { const r = staffTextFulfillsAixItem(it, early.text); sim = { name: it.customer_name ?? "?", action: it.action, kind: "登録しない（先に返信で済み）", at: ms(it.created_at), basis: `${r.done ? r.basis : ""}「${one(early.text, 50)}」`, actualEnd }; }
    }
    if (!sim) {
      // pending の間の出来事を時刻順に: 返信で済み／新しいお客様の番の判断が保留
      const evs: Array<{ t: number; kind: Sim["kind"]; basis: string }> = [];
      for (const m of cm) {
        const t = ms(m.created_at);
        if (t <= Math.max(turnT, ms(it.created_at)) || t > end || m.sender !== "staff" || m.is_aix_generated) continue;
        const r = staffTextFulfillsAixItem(it, m.text);
        if (r.done) { evs.push({ t, kind: "済み", basis: `${r.basis}「${one(m.text, 50)}」` }); break; }
      }
      for (const l of L.get(cid) ?? []) {
        const t = ms(l.created_at);
        if (t < ms(it.created_at) || t > end || !l.analyzed_msg_ts || ms(l.analyzed_msg_ts) <= turnT + 5000 || l.analysis_mode === "cached") continue;
        if (!l.suggested_action || l.suggested_reply_mode !== "aix") continue; // AIX なしは今までも取り下げ（brain_no_aix）
        const p = brainPausedCustomer(metaOf(l));
        if (p.paused) { const turn = [...cm].reverse().find((m) => m.sender === "customer" && ms(m.created_at) <= ms(l.analyzed_msg_ts) + 5000); evs.push({ t, kind: "取り下げ", basis: `${p.reason}「${one(turn?.text, 50)}」` }); break; }
      }
      evs.sort((a, b) => a.t - b.t);
      if (evs[0]) sim = { name: it.customer_name ?? "?", action: it.action, kind: evs[0].kind, at: evs[0].t, basis: evs[0].basis, actualEnd };
    }
    if (!sim) continue;
    // 誤り: 片付けた時刻の後、次のお客様の発言までに同じ系統の AIX を押した（その後の宣言で登録し直される番は除く）
    const nextCust = cm.find((m) => m.sender === "customer" && ms(m.created_at) > sim!.at + 1000);
    const W = nextCust ? ms(nextCust.created_at) : sim.at + 7 * 864e5;
    const pressedList = (U.get(cid) ?? []).filter((u) => { const t = ms(u.sent_at ?? u.created_at); return t > sim!.at && t <= W + 90_000; });
    const sameP = pressedList.find((u) => fam(u.aix_type) === fam(it.action));
    const reReg = !!sameP && cm.some((x) => x.sender === "staff" && !x.is_aix_generated && ms(x.created_at) >= sim!.at - 1000 && ms(x.created_at) < ms(sameP.sent_at ?? sameP.created_at) && !!x.text && hasPromise(x.text));
    sims.push({ ...sim, err: !!sameP && !reReg, pressedAfter: pressedList.map((u) => u.aix_type).join(",") + (reReg ? "（宣言で登録し直し）" : ""), savedMin: Math.max(0, (Math.min(end, Date.now()) - sim.at) / 60000) });
  }
  console.log(`\n■ ③ 過去の AIX要対応（${ITEMS_SINCE}〜・YUMA 除く ${seen}件）に当てた前後`);
  const kinds = ["済み", "取り下げ", "登録しない（先に返信で済み）", "登録しない（保留）"] as const;
  for (const k of kinds) {
    const xs = sims.filter((s) => s.kind === k);
    const byAct: Record<string, number> = {};
    for (const s of xs) byAct[s.action] = (byAct[s.action] ?? 0) + 1;
    console.log(`  ${k}: ${xs.length}件（誤り＝その後に同じ AIX を押した ${xs.filter((s) => s.err).length}）・減る pending 延べ ${Math.round(xs.reduce((a, s) => a + s.savedMin, 0) / 60)}時間 ・${Object.entries(byAct).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join("・")}`);
  }
  for (const s of sims.filter((x) => x.err)) console.log(`   ✗誤り ${s.name} ${s.action} ${s.kind} ${jst(s.at)} ${s.basis} → 押=${s.pressedAfter}`);
  for (const s of sims.slice(-READ)) console.log(`   ${s.kind} ${s.name} [${s.action}] ${jst(s.at)} ${s.basis} ｜今まで: ${s.actualEnd}（片付けの後 ${Math.round(s.savedMin)}分 残っていた）${s.pressedAfter ? " 押=" + s.pressedAfter : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
