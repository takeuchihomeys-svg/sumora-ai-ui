// scripts/audit-word-vs-brain.ts
// 2026-10-08 竹内さん「旧ルールで、文の単語だけで変に判断してしまってボトルネックになっているのがあるはずやから、ちゃんとブレインを基盤に読み取るようにする」:
//   お客様の番の文を語・正規表現だけで読んで「場面・意図・次の一手」を決めている所を、本番のブレインの判断（brain_decision_logs の digest・Claude）と
//   その番のスタッフの実際（返事のまとまりの手打ち・押した AIX・書き手）に当てて、食い違い・誤検知・見逃しを数える。読むだけ・LLM なし。
//   申込以降（application_push を押した後）・テストの会話は除く。番ごとに最後の判断だけ。
// 実行: npx tsx --env-file=.env.local scripts/audit-word-vs-brain.ts [--days=40] [--show=12] [--only=scene|estimate|...] [--out=scripts/.replay-out/word-vs-brain.jsonl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { isMisumoriContextAppropriate, countSentProperties } from "../app/lib/estimate-context";
import { STAFF_ESTIMATE_PROMISE_RE } from "../app/lib/line-reply-prompts";
import { adoptSignalAixOverBrainNull } from "../app/lib/brain-keyword-rules";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "40"));
const SHOW = Number(arg("show", "12"));
const ONLY = arg("only", "");
const OUT = arg("out", "");

type Msg = WindowMsg & { conversation_id: string; staff_writer?: string | null };
type Press = WindowPress & { conversation_id: string };
type Digest = { intent?: string | null; q?: string[]; aix?: string | null; dir?: string | null; cond?: string | null; hes?: string | null; concern?: string | null; prop?: string | null };
type Dec = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null; digest: Digest | null };

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 600_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const one = (s: string, n = 70) => s.replace(/\s+/g, " ").slice(0, n);

export type TurnRow = {
  cid: string; at: string; cust: string; lastCust: string; earlierCust: string[]; lastStaff: string; sent: number;
  brain: { intent: string | null; q: string[]; aix: string | null; mode: string | null; dir: string | null; cond: string | null; hes: string | null; prop: string | null; src: string | null };
  staff: { presses: string[]; allPresses: string[]; text: string; writer: string | null } | null;
  draft: string | null;
};

async function main() {
  const since = new Date(Date.now() - (DAYS + 30) * 86_400_000).toISOString();
  const decSince = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, presses, decs, lwt] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, decision_source, digest").gte("created_at", decSince).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; customer_last_at: string | null; draft_last: string | null; verdict: string | null }>((f, t) => sb.from("line_watch_turns").select("conversation_id, customer_last_at, draft_last, verdict").order("created_at").range(f, t)),
  ]);
  // 見張り（line_watch_turns・10/01〜）の下書き（番の最後の顧客発言の時刻で結ぶ）
  const draftOf = new Map<string, string>();
  const verdictOf = new Map<string, string>();
  for (const l of lwt) if (l.customer_last_at) { const kk = `${l.conversation_id}|${Math.round(Date.parse(l.customer_last_at) / 1000)}`; if (l.draft_last) draftOf.set(kk, l.draft_last); if (l.verdict) verdictOf.set(kk, l.verdict); }
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses);
  const last = new Map<string, Dec>();
  for (const d of decs) { if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id)) continue; last.set(`${d.conversation_id}|${d.analyzed_msg_ts}`, d); }

  const rows: TurnRow[] = [];
  for (const d of last.values()) {
    const ps = pBy.get(d.conversation_id) ?? [];
    const applyAt = ps.find((p) => p.aix_type === "application_push")?.created_at;
    if (applyAt && Date.parse(d.analyzed_msg_ts!) >= Date.parse(applyAt)) continue;
    const ms = mBy.get(d.conversation_id) ?? [];
    const tMs = Date.parse(d.analyzed_msg_ts!);
    const upto = ms.filter((m) => Date.parse(m.created_at) <= tMs + 1000);
    let k = upto.length - 1;
    const custs: string[] = [];
    while (k >= 0 && upto[k].sender === "customer") { custs.unshift(upto[k].text ?? ""); k--; }
    if (!custs.length) continue;
    const lastStaff = k >= 0 ? (upto.slice(0, k + 1).reverse().find((m) => m.sender === "staff" && m.text && !/^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/.test(m.text))?.text ?? "") : "";
    const hist = upto.slice(-60).map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated }));
    const w = staffWindowOf({ customerTurnAt: d.analyzed_msg_ts!, msgs: ms, presses: ps });
    const burstTexts = w.texts.filter((t) => t.burst);
    const writers = ms.filter((m) => m.sender === "staff" && burstTexts.some((t) => t.at === m.created_at)).map((m) => m.staff_writer).filter(Boolean) as string[];
    const g = d.digest ?? {};
    rows.push({
      cid: d.conversation_id, at: d.analyzed_msg_ts!, cust: custs.join("\n"), lastCust: custs[custs.length - 1], earlierCust: custs.slice(0, -1), lastStaff,
      sent: countSentProperties(hist),
      brain: { intent: g.intent ?? null, q: Array.isArray(g.q) ? g.q : [], aix: d.suggested_reply_mode === "aix" ? d.suggested_action : (g.aix ?? null), mode: d.suggested_reply_mode, dir: g.dir ?? null, cond: g.cond ?? null, hes: g.hes ?? null, prop: g.prop ?? null, src: d.decision_source },
      draft: draftOf.get(`${d.conversation_id}|${Math.round(tMs / 1000)}`) ?? null,
      staff: w.closed ? { presses: [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))], allPresses: [...new Set(w.presses.map((p) => p.aix_type))], text: burstTexts.map((t) => t.text).join(" / "), writer: writers[0] ?? null } : null,
    });
  }
  console.log(`番 ${rows.length}（${DAYS}日・番ごとの最後の判断・申込以降とテストを除く）・スタッフの返事が閉じた番 ${rows.filter((r) => r.staff).length}・竹内さんの手打ちを含む番 ${rows.filter((r) => r.staff?.writer === "takeuchi").length}`);
  const out: unknown[] = [];

  // ── ① 返信の場面（reply-scene・語だけ）× ブレイン ──────────────────────────
  if (!ONLY || ONLY === "scene") {
    const tab = new Map<string, number>();
    const conflicts = new Map<string, { n: number; tk: number; ex: string[] }>();
    const add = (k: string, r: TurnRow, note: string) => {
      const c = conflicts.get(k) ?? { n: 0, tk: 0, ex: [] }; c.n++; if (r.staff?.writer === "takeuchi") c.tk++;
      if (c.ex.length < SHOW) c.ex.push(`${r.cid.slice(0, 8)} ${r.at.slice(5, 16)}｜C:${one(r.cust)}｜B:${r.brain.intent ?? "-"}/${r.brain.aix ?? "返信"}/q=${one(r.brain.q.join("・"), 40)}｜S:${r.staff ? (r.staff.presses.join("+") || "") + one(r.staff.text, 60) : "（閉じていない）"}${note}`);
      conflicts.set(k, c);
      out.push({ kind: `scene:${k}`, cid: r.cid, at: r.at, cust: r.cust, brain: r.brain, staff: r.staff });
    };
    for (const r of rows) {
      const s = resolveReplyScene({ customerText: r.cust });
      tab.set(`${s.scene}×${r.brain.intent ?? "null"}`, (tab.get(`${s.scene}×${r.brain.intent ?? "null"}`) ?? 0) + 1);
      const hasQ = r.brain.q.length > 0;
      if (s.scene === "ack" && (hasQ || r.brain.cond)) add(`ack なのにブレインは質問/条件変更（材料を落とす: questions・conditions・conditionChange 等）`, r, "");
      if (s.scene === "considering" && (hasQ || r.brain.cond) && !r.brain.hes) add(`considering なのにブレインは保留でなく質問/条件変更`, r, "");
      if (s.scene === "property_share" && r.brain.cond && !/https?:\/\/|\[画像\]/.test(r.cust)) add("property_share（語）なのにブレインは条件変更", r, "");
      if (s.scene === "conditions" && !r.brain.cond && hasQ && r.brain.intent === "question") add(`conditions なのにブレインは条件変更なし・質問`, r, "");
      if (s.scene === "cost" && !r.brain.q.some((q) => /費用|見積|総額|いくら|金額|家賃|敷金|礼金|割引|安く/.test(q)) && r.brain.aix !== "estimate_sheet" && !/見積|費用|初期/.test(r.brain.dir ?? "")) add(`cost なのにブレインは費用の質問なし`, r, "");
      if (s.scene === "apply" && !/申込|申し込|審査|契約|書類|保証|入居日|抑え|押さえ/.test(`${r.brain.q.join(" ")} ${r.brain.dir ?? ""}`) && r.brain.aix !== "application_push") add(`apply なのにブレインの質問・方向に申込・審査が無い`, r, "");
      if (s.scene === "other" && hasQ) add(`other（決めきれず全部の材料）・ブレインは質問あり`, r, "");
    }
    console.log(`\n① 返信の場面（語）× ブレインの意図（customer_intent）`);
    const scenes = [...new Set([...tab.keys()].map((k) => k.split("×")[0]))];
    const intents = [...new Set([...tab.keys()].map((k) => k.split("×")[1]))];
    console.log(["場面\\意図", ...intents].join("\t"));
    for (const s of scenes) console.log([s, ...intents.map((i) => tab.get(`${s}×${i}`) ?? 0)].join("\t"));
    for (const [k, c] of [...conflicts.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`\n■ ${k}: ${c.n}番（竹内さんの手打ち ${c.tk}）`);
      for (const e of c.ex) console.log("  " + e);
    }
  }

  // ── ② 見積の文脈（estimate-context・語だけ）× ブレイン × スタッフ ───────────────
  if (!ONLY || ONLY === "estimate") {
    const cell = new Map<string, { n: number; tk: number; ex: string[] }>();
    for (const r of rows) {
      if (!r.staff) continue;
      // 本番に近い形: ブレインが新しい（digest の意図・質問・物件・条件変更・AIX を渡す）
      const bm = { customer_intent: r.brain.intent, customer_questions: r.brain.q, current_property: r.brain.prop, condition_change_type: r.brain.cond, action: r.brain.aix, avoid_topics: [] } as never;
      const v = isMisumoriContextAppropriate({ customerMessage: r.lastCust, recentCustomerMessages: r.earlierCust, sentPropertiesCount: r.sent, lastStaffMessage: r.lastStaff, brainFresh: true, brainMeta: bm, brainAction: r.brain.aix });
      if (v.mode !== "declare") continue;
      const staffEst = r.staff.presses.includes("estimate_sheet") || STAFF_ESTIMATE_PROMISE_RE.test(r.staff.text) || /見積/.test(r.staff.text);
      const brainEst = r.brain.aix === "estimate_sheet" || /見積/.test(r.brain.dir ?? "") || r.brain.q.some((q) => /見積|費用|いくら|総額/.test(q));
      const draftEst = r.draft ? STAFF_ESTIMATE_PROMISE_RE.test(r.draft) : null;
      const k = `${v.trigger}${v.signals.includes("re:property_positive") && v.trigger === "after_property_sent" ? "(語の前向き)" : ""}｜ブレイン${brainEst ? "見積あり" : "見積なし"}｜スタッフ${staffEst ? "見積あり" : "見積なし"}`;
      const c = cell.get(k) ?? { n: 0, tk: 0, ex: [] }; c.n++; if (r.staff.writer === "takeuchi") c.tk++;
      if (draftEst) (c as { d?: number }).d = ((c as { d?: number }).d ?? 0) + 1;
      if (c.ex.length < SHOW && !staffEst) c.ex.push(`${r.cid.slice(0, 8)} ${r.at.slice(5, 16)}｜C:${one(r.cust)}｜B:${r.brain.intent ?? "-"}/${r.brain.aix ?? "返信"}/dir=${one(r.brain.dir ?? "", 40)}｜S:${r.staff.presses.join("+")} ${one(r.staff.text, 60)}｜ev=${v.evidence ?? ""}${r.draft ? `｜D(見積${draftEst ? "あり" : "なし"}):${one(r.draft, 60)}` : ""}`);
      cell.set(k, c);
      if (!staffEst) out.push({ kind: `estimate:${v.trigger}:${brainEst ? "brain_est" : "brain_no"}`, cid: r.cid, at: r.at, cust: r.cust, brain: r.brain, staff: r.staff, evidence: v.evidence });
    }
    console.log(`\n② 見積の文脈（語だけで declare＝御見積書の約束を書いてよい）× ブレイン × スタッフ（閉じた番）`);
    for (const [k, c] of [...cell.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`■ ${k}: ${c.n}（竹内さん ${c.tk}・下書きが見積の約束 ${(c as { d?: number }).d ?? 0}）`);
      for (const e of c.ex) console.log("  " + e);
    }
  }

  // ── ③ ブレインの LLM の判断を後から語で直す規則（brain-core の decision_source）× スタッフの実際 ─────────────
  //   LLM の元の判断は残っていないので、規則が決めた最終の一手（AIX／返信）とスタッフの返事のまとまり（押した AIX・手打ち）を比べる。
  //   一致: 同じ AIX を押した／規則が返信（AIX なし）でスタッフも手打ちだけ。基準は decision_source=llm（規則が触っていない番）
  if (!ONLY || ONLY === "rules") {
    const cell = new Map<string, { n: number; hit: number; win: number; tk: number; tkHit: number; ex: string[] }>();
    for (const r of rows) {
      if (!r.staff) continue;
      const src0 = r.brain.src ?? "(なし)";
      const src = src0.replace(/\(.*\)$/, "").replace(/\+ack_to_check$/, "");
      const brainAix = r.brain.mode === "aix" ? r.brain.aix : (src0.startsWith("no_aix:") ? null : r.brain.aix);
      const staffAix = r.staff.presses;
      const staffReplyOnly = !staffAix.length && !!r.staff.text.trim();
      const hit = brainAix ? staffAix.includes(brainAix) : staffReplyOnly;
      const winHit = brainAix ? r.staff.allPresses.includes(brainAix) : hit;
      const c = cell.get(src) ?? { n: 0, hit: 0, win: 0, tk: 0, tkHit: 0, ex: [] };
      c.n++; if (hit) c.hit++; if (winHit) c.win++;
      if (r.staff.writer === "takeuchi") { c.tk++; if (hit) c.tkHit++; }
      if (!winHit && c.ex.length < SHOW) c.ex.push(`${r.cid.slice(0, 8)} ${r.at.slice(5, 16)}｜C:${one(r.cust, 60)}｜B:${brainAix ?? "返信"}${src0 !== src ? ` ${src0.slice(src.length, src.length + 40)}` : ""}｜S:${staffAix.join("+") || "手打ち"}${r.staff.allPresses.length ? `（窓:${r.staff.allPresses.join("+")}）` : ""} ${one(r.staff.text, 50)}`);
      cell.set(src, c);
      if (!hit) out.push({ kind: `rule:${src}`, cid: r.cid, at: r.at, cust: r.cust, brain: r.brain, staff: r.staff });
    }
    console.log(`\n③ ブレインの判断の出どころ（decision_source）ごとの スタッフとの一致（閉じた番）`);
    for (const [k, c] of [...cell.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`■ ${k}: ${c.n}番 まとまり一致 ${c.hit}（${Math.round((100 * c.hit) / c.n)}%）・次の発言までに押した ${c.win}（${Math.round((100 * c.win) / c.n)}%）・竹内さん ${c.tk}番中 一致 ${c.tkHit}`);
      if (k !== "llm" && k !== "(なし)") for (const e of c.ex) console.log("  " + e);
    }
  }

  // ── ④ 10/08 の直し（ブレインの「AIX なし」を信号で上書きしない）の前後（全期間・brain-aix-eval の matched／actual_aix_type）─────────
  if (!ONLY || ONLY === "signal-null") {
    const all = await readAll<{ decision_source: string; matched: boolean | null; actual_aix_type: string | null; conversation_id: string }>((f, t) => sb.from("brain_decision_logs").select("decision_source, matched, actual_aix_type, conversation_id").like("decision_source", "signal:%").range(f, t));
    // 信号の出どころ: detectSignalBasedAixFallback は `signal:<AIX のキー>`・場面の信号は signal:scene_S2/S3/S5/S11（S3_guarantor・S4_date_alt 等は別の規則）
    const FALLBACK = /^signal:(?:property_recommendation|property_search|property_send|followup_revive|application_push|estimate_sheet|acknowledge_check|property_check_result|viewing_invite|meeting_place|condition_hearing|cost_explain|cost_breakdown|phone_call)$/;
    const dropped = (s: string) => FALLBACK.test(s) ? adoptSignalAixOverBrainNull(true, { kind: "signal", action: s.slice(7) }, {}) === false
      : s === "signal:scene_S5" ? adoptSignalAixOverBrainNull(true, { kind: "scene", scene: "S5_time_spec" }, {}) === false : false;
    let n = 0, ev = 0, hit = 0, noAix = 0;
    const per = new Map<string, number>();
    for (const d of all) {
      if (isTestConversation(d.conversation_id) || !dropped(d.decision_source)) continue;
      n++; per.set(d.decision_source, (per.get(d.decision_source) ?? 0) + 1);
      if (d.matched !== null) { ev++; if (d.matched) hit++; if (!d.actual_aix_type) noAix++; }
    }
    console.log(`\n④ 直しで AIX なしに戻る番（全期間・テストの会話を除く）: ${n}番（評価済み ${ev}）→ 旧: スタッフが同じ AIX を押した ${hit}・AIX を押さなかった ${noAix}（新では一致に変わる）`);
    console.log("  " + [...per.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・"));
  }

  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join("\n")); console.log(`\n書き出し: ${OUT}（${out.length}行）`); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
