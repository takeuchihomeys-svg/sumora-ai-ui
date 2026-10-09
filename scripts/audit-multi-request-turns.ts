// scripts/audit-multi-request-turns.ts — お客様の連投に依頼が2つ以上ある番で、人（既定は竹内さん＝staff_writer takeuchi）がどう返したか（読むだけ・LLM なし）
//   2026-10-09 竹内さん「複数の依頼が重なる番は、ちゃんと返信して約束してから AIX をセットしたらどうか…約束した事を記録して、それを AIX で送っていけば完全にできる」
//   ①番の数と型（依頼の種類の組）②人の最初の返し（まとめて約束／1つだけ約束／AIX から）③その後の AIX（本数・順・全部果たすまでの時間）
//   ④取りこぼし（約束したのに送っていない＝promise-queue の pending・約束も答えもしなかった依頼＝request-ledger の open）
//   ⑤今の仕組み: 2本目以降の約束の AIX要対応が立っていたか・下書き（ai_reply_examples.ai_draft）が依頼に触れた数・ブレインの2段が1種類だった番
// 実行: npx tsx --env-file=.env.local scripts/audit-multi-request-turns.ts [--days=60] [--writer=takeuchi|employee|all] [--show=wording|drop|seq] [--n=30]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { splitRequests, buildRequestLedger, uncoveredRequests, TOPIC_JA, type LedgerMsg } from "../app/lib/request-ledger";
import { promisesInStaffText, buildPromiseQueue, nextPromiseAix, PROMISE_KIND_JA, type QueueAixLog } from "../app/lib/promise-queue";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60")); const WRITER = arg("writer", "takeuchi"); const SHOW = arg("show", ""); const N = Number(arg("n", "30"));
const WIN_H = 72;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function all<T>(q: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 1_000_000; i += 1000) {
    let r = await q(i);
    for (let t = 0; t < 3 && r.error && /timeout/i.test(r.error.message); t++) { await new Promise((z) => setTimeout(z, 3000)); r = await q(i); }
    const { data, error } = r;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[]; out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}
type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
type L = { conversation_id: string; aix_type: string; check_pattern: string | null; sent_at: string | null; created_at: string; estimate_sent: boolean | null; generated_text: string | null };
type I = { conversation_id: string; action: string; created_at: string; status: string; resolution_note: string | null };
type E = { conversation_id: string; sent_at: string | null; created_at: string; ai_draft: string | null; sent_reply: string | null };
type D = { conversation_id: string; analyzed_msg_ts: string | null; decision_source: string | null; suggested_action: string | null; created_at: string };

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const hrs = (ms: number) => (Number.isFinite(ms) ? `${(ms / 3600_000).toFixed(1)}h` : "-");

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const [msgs, logs, items, exs, decs, convs] = await Promise.all([
    all<M>((i) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").order("id").range(i, i + 999)),
    all<L>((i) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, created_at, estimate_sent, generated_text").gte("created_at", since).order("created_at").range(i, i + 999)),
    all<I>((i) => sb.from("aix_action_items").select("conversation_id, action, created_at, status, resolution_note").gte("created_at", since).order("created_at").range(i, i + 999)),
    all<E>((i) => sb.from("ai_reply_examples").select("conversation_id, sent_at, created_at, ai_draft, sent_reply").gte("created_at", since).order("created_at").range(i, i + 999)),
    all<D>((i) => sb.from("brain_decision_logs").select("conversation_id, analyzed_msg_ts, decision_source, suggested_action, created_at").gte("created_at", since).order("created_at").range(i, i + 999)),
    all<{ id: string; is_post_apply: boolean | null }>((i) => sb.from("conversations").select("id, is_post_apply").range(i, i + 999)),
  ]);
  const postApply = new Set(convs.filter((c) => c.is_post_apply).map((c) => c.id));
  const byConv = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const logsBy = new Map<string, L[]>(); for (const l of logs) (logsBy.get(l.conversation_id) ?? logsBy.set(l.conversation_id, []).get(l.conversation_id)!).push(l);
  const itemsBy = new Map<string, I[]>(); for (const x of items) (itemsBy.get(x.conversation_id) ?? itemsBy.set(x.conversation_id, []).get(x.conversation_id)!).push(x);
  const exBy = new Map<string, E[]>(); for (const x of exs) (exBy.get(x.conversation_id) ?? exBy.set(x.conversation_id, []).get(x.conversation_id)!).push(x);
  const decBy = new Map<string, D[]>(); for (const x of decs) (decBy.get(x.conversation_id) ?? decBy.set(x.conversation_id, []).get(x.conversation_id)!).push(x);

  let turns = 0, multi = 0, firstAix = 0, firstHand = 0, bundled = 0, onePromise = 0, answerOnly = 0, noReply = 0;
  let steps = 0, stepsDone = 0, stepsDropped = 0, stepsPending = 0, turnsAllDone = 0, turnsWithSteps = 0, multiStepTurns = 0;
  let openItems = 0, itemsTotal = 0, openTurns = 0;
  let nextSet = 0, nextNeeded = 0;
  let draftTurns = 0, draftItemsCovered = 0, draftItemsTotal = 0, draftPromiseKinds = 0, humanPromiseKinds = 0, draftOneWhileHumanMulti = 0;
  let twoStageTurns = 0, twoStageOneKindHumanMulti = 0;
  const combo: Record<string, number> = {}; const seq: Record<string, number> = {}; const aixCount: Record<number, number> = {};
  const doneTimes: number[] = []; const gapTimes: number[] = [];
  const exWording: string[] = [], exDrop: string[] = [], exSeq: string[] = [], exOne: string[] = [];
  for (const [cid, list] of byConv) {
    if (postApply.has(cid)) continue;
    const cLogs = (logsBy.get(cid) ?? []).map((l) => ({ ...l, at: l.sent_at ?? l.created_at }));
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
      let j = i; while (j < list.length && list[j].sender === "customer") j++;
      if (j >= list.length) continue;
      const first = list[j];
      if (WRITER !== "all" && first.staff_writer !== WRITER) continue;
      const bundle = list.slice(i, j).map((m) => String(m.text ?? ""));
      const T = Date.parse(list[j - 1].created_at);
      turns++;
      const its = splitRequests(bundle, list[i].created_at).filter((x) => x.topic !== "other" && !x.deferred);
      if (its.length < 2) continue;
      multi++;
      const key = [...new Set(its.map((x) => TOPIC_JA[x.topic]))].sort().join("+") + (new Set(its.map((x) => x.topic)).size < its.length ? "（同じ種類が複数）" : "");
      combo[key] = (combo[key] ?? 0) + 1;
      const end = T + WIN_H * 3600_000;
      const win = list.slice(j).filter((m) => Date.parse(m.created_at) <= end);
      const staffWin = win.filter((m) => m.sender !== "customer");
      if (!staffWin.length) { noReply++; continue; }
      const firstHandMsg = staffWin.find((m) => !m.is_aix_generated && String(m.text ?? "").trim().length > 3 && !/^\[(?:画像|動画|スタンプ|ファイル)/.test(String(m.text ?? "").trim()));
      if (first.is_aix_generated) firstAix++; else firstHand++;
      const hp = firstHandMsg ? promisesInStaffText(firstHandMsg.text, firstHandMsg.created_at) : [];
      humanPromiseKinds += hp.length;
      if (!first.is_aix_generated) { if (hp.length >= 2) bundled++; else if (hp.length === 1) onePromise++; else answerOnly++; }
      if (!first.is_aix_generated && hp.length <= 1 && exOne.length < N) exOne.push(`${cid.slice(0, 6)} ${list[i].created_at.slice(5, 16)} [${key}] 約束=${hp.map((p) => PROMISE_KIND_JA[p.kind]).join("・") || "なし"}｜客: ${bundle.join(" / ").replace(/s+/g, " ").slice(-160)}｜人: ${String(firstHandMsg?.text ?? "").replace(/s+/g, " ").slice(0, 160)}`);
      if (hp.length >= 2 && exWording.length < N) exWording.push(`${cid.slice(0, 6)} ${list[i].created_at.slice(5, 16)} [${key}] 約束=${hp.map((p) => PROMISE_KIND_JA[p.kind]).join("・")}｜人: ${String(firstHandMsg!.text).replace(/\s+/g, " ").slice(0, 200)}`);
      // AIX の並び（72時間）
      const winLogs = cLogs.filter((l) => Date.parse(l.at) > T && Date.parse(l.at) <= end);
      aixCount[Math.min(winLogs.length, 4)] = (aixCount[Math.min(winLogs.length, 4)] ?? 0) + 1;
      if (winLogs.length) { const s = winLogs.map((l) => l.aix_type).join("→"); seq[s] = (seq[s] ?? 0) + 1; }
      // 約束の並び（この番の後の約束だけ）
      const qMsgs = [...list.slice(i, j), ...win].map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }));
      const qLogs: QueueAixLog[] = winLogs.map((l) => ({ aixType: l.aix_type, checkPattern: l.check_pattern, sentAt: l.at, estimateSent: l.estimate_sent, text: l.generated_text }));
      const q = buildPromiseQueue(qMsgs, qLogs, end, { windowDays: 4 }).filter((s) => Date.parse(s.promisedAt) > T);
      if (q.length) {
        turnsWithSteps++; if (q.length >= 2) multiStepTurns++;
        steps += q.length;
        const d = q.filter((s) => s.status === "done"), dr = q.filter((s) => s.status === "dropped"), p = q.filter((s) => s.status === "pending");
        stepsDone += d.length; stepsDropped += dr.length; stepsPending += p.length;
        if (!p.length) { turnsAllDone++; const last = Math.max(...q.map((s) => Date.parse(s.doneAt ?? s.promisedAt))); doneTimes.push(last - T); }
        if (p.length && exDrop.length < N) exDrop.push(`${cid.slice(0, 6)} ${list[i].created_at.slice(5, 16)} 果たしていない=${p.map((s) => PROMISE_KIND_JA[s.kind]).join("・")}｜済=${d.map((s) => `${PROMISE_KIND_JA[s.kind]}(${s.doneBy})`).join("・")}｜約束: ${String(firstHandMsg?.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
        // 2本目以降: 1本目を果たした後、2本目の AIX要対応が（2本目を果たす前に）立っていたか
        const ds = d.filter((s) => s.doneBy?.startsWith("AIX")).sort((a, b) => Date.parse(a.doneAt!) - Date.parse(b.doneAt!));
        for (let k = 1; k < ds.length; k++) {
          nextNeeded++;
          gapTimes.push(Date.parse(ds[k].doneAt!) - Date.parse(ds[k - 1].doneAt!));
          const hit = (itemsBy.get(cid) ?? []).some((x) => Date.parse(x.created_at) >= Date.parse(ds[k - 1].doneAt!) - 60_000 && Date.parse(x.created_at) <= Date.parse(ds[k].doneAt!) && x.action === ds[k].action);
          if (hit) nextSet++;
        }
        if (q.length >= 2 && exSeq.length < N) exSeq.push(`${cid.slice(0, 6)} ${list[i].created_at.slice(5, 16)} ${q.map((s) => `${PROMISE_KIND_JA[s.kind]}:${s.status}${s.doneAt ? `@+${hrs(Date.parse(s.doneAt) - T)}` : ""}${s.doneBy ? `(${s.doneBy})` : ""}`).join(" → ")}`);
      }
      // 約束も答えもしなかった依頼
      const led = buildRequestLedger([...list.slice(i, j), ...win].map((m): LedgerMsg => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated })), end, { windowDays: 4 })
        .filter((x) => Date.parse(x.saidAt) === Date.parse(list[i].created_at) && x.topic !== "other" && !x.deferred);
      itemsTotal += led.length;
      const op = led.filter((x) => x.status === "open"); openItems += op.length; if (op.length) openTurns++;
      // 下書き（最初の手打ちに対の ai_draft）
      if (firstHandMsg) {
        const fAt = Date.parse(firstHandMsg.created_at);
        const ex = (exBy.get(cid) ?? []).find((x) => Math.abs(Date.parse(x.sent_at ?? x.created_at) - fAt) < 5 * 60_000 && x.ai_draft);
        if (ex?.ai_draft) {
          draftTurns++;
          draftItemsTotal += its.length; draftItemsCovered += its.length - uncoveredRequests(its, ex.ai_draft).length;
          const dp = promisesInStaffText(ex.ai_draft, firstHandMsg.created_at);
          draftPromiseKinds += dp.length;
          if (hp.length >= 2 && dp.length < hp.length) draftOneWhileHumanMulti++;
        }
      }
      // ブレインの2段（この番を見た判断）
      const dec = (decBy.get(cid) ?? []).filter((x) => x.analyzed_msg_ts && Math.abs(Date.parse(x.analyzed_msg_ts) - T) < 5_000).pop();
      if (dec && /two_stage_promise/.test(dec.decision_source ?? "")) { twoStageTurns++; if (hp.length >= 2) twoStageOneKindHumanMulti++; }
    }
  }
  // ⑥ 試算（promise-queue.advancePromiseQueue を過去に当てる・書き手は問わない）: AIX を1本送った直後に「次の AIX要対応」を立てたら、
  //   その約束を72時間以内に人が果たしたか（当たり）・果たさなかったか（外れ＝要らない要対応）。ブレインの要対応が開いていた時は立てない
  const simSeen = new Set<string>(); let simAix = 0, simRaise = 0, simHit = 0, simBrainOpen = 0; const simKinds: Record<string, [number, number]> = {}; const exSim: string[] = [];
  for (const [cid, list] of byConv) {
    if (postApply.has(cid)) continue;
    const cLogs = (logsBy.get(cid) ?? []).map((l) => ({ ...l, at: l.sent_at ?? l.created_at }));
    const qMsgsAll = list.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }));
    const qLogsAll: QueueAixLog[] = cLogs.map((l) => ({ aixType: l.aix_type, checkPattern: l.check_pattern, sentAt: l.at, estimateSent: l.estimate_sent, text: l.generated_text }));
    for (const l of cLogs) {
      simAix++;
      const t = Date.parse(l.at) + 1000;
      const q = buildPromiseQueue(qMsgsAll, qLogsAll.filter((x) => Date.parse(x.sentAt) < t), t, { windowDays: 7 });
      const nx = nextPromiseAix(q, { nowMs: t });
      if (!nx) continue;
      const open = (itemsBy.get(cid) ?? []).some((x) => Date.parse(x.created_at) < t && x.status === "pending" && !/^rule:viewing_morning/.test(x.resolution_note ?? ""));
      // 今は開いている行の時刻だけ分かる（済みの時刻は読まない）＝ pending のまま残る行だけ数える（控えめ）
      if (open) { simBrainOpen++; continue; }
      const dk = `${cid}|${nx.next.kind}|${nx.next.promisedAt}`; if (simSeen.has(dk)) continue; simSeen.add(dk);
      simRaise++;
      const later = buildPromiseQueue(qMsgsAll, qLogsAll, t + 72 * 3600_000, { windowDays: 7 });
      const same = later.find((x) => x.kind === nx.next.kind && x.promisedAt === nx.next.promisedAt);
      const hit = !!same && same.status !== "pending";
      if (hit) simHit++;
      const k = PROMISE_KIND_JA[nx.next.kind]; simKinds[k] = simKinds[k] ?? [0, 0]; simKinds[k][0]++; if (hit) simKinds[k][1]++;
      if (!hit && exSim.length < N) exSim.push(`${cid.slice(0, 6)} ${l.at.slice(5, 16)} 送った AIX=${l.aix_type} → 立てる=${k}（約束 ${nx.next.promisedAt.slice(5, 16)}「${nx.next.evidence}」）→ 72時間で果たさず`);
    }
  }
  console.log(`⑥ 試算（全スタッフ・${DAYS}日の AIX ${simAix} 本の直後）: 次の要対応を立てる ${simRaise}（同じ約束は1回）（ブレインの行が開いていて立てない ${simBrainOpen}）・そのうち72時間以内に人が果たした ${simHit}（${pct(simHit, simRaise)}）・種類: ${Object.entries(simKinds).map(([k, [a, b]]) => `${k} ${b}/${a}`).join("・")}`);
  if (SHOW === "sim") { console.log("\n== sim（外れ）"); for (const e of exSim) console.log("  " + e); }
  console.log(`== 直近 ${DAYS} 日・書き手 ${WRITER}・申込前・テスト会話を除く`);
  console.log(`番（お客様の連投→こちらの最初の送信が ${WRITER}） ${turns}・依頼が2つ以上 ${multi}（${pct(multi, turns)}）・72時間返していない ${noReply}`);
  console.log(`型（上位）: ${Object.entries(combo).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join("／")}`);
  console.log(`最初の送信: AIX から ${firstAix}・手打ち ${firstHand}（まとめて約束＝2種類以上 ${bundled}・約束1種類 ${onePromise}・約束なし（答え・受け） ${answerOnly}）`);
  console.log(`その後 72時間の AIX の本数: ${Object.entries(aixCount).map(([k, v]) => `${k === "4" ? "4本以上" : `${k}本`} ${v}`).join("・")}`);
  console.log(`AIX の並び（上位）: ${Object.entries(seq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join("／")}`);
  console.log(`約束（promise-queue・番の後の約束）: 約束のある番 ${turnsWithSteps}（2つ以上 ${multiStepTurns}）・約束 ${steps}＝果たした ${stepsDone}・やめた（募集終了） ${stepsDropped}・72時間で果たしていない ${stepsPending}`);
  console.log(`全部果たした番 ${turnsAllDone}/${turnsWithSteps}・番から全部果たすまで 中央 ${hrs(med(doneTimes))}・AIX の間（1本目→2本目…）中央 ${hrs(med(gapTimes))}`);
  console.log(`2本目以降の AIX: ${nextNeeded} 本のうち、前の AIX の後にその AIX要対応が立っていた ${nextSet}（${pct(nextSet, nextNeeded)}）`);
  console.log(`約束も答えもしなかった依頼（72時間）: ${openItems}/${itemsTotal}（その番 ${openTurns}）`);
  console.log(`下書き（最初の手打ちに対の AI の下書き ${draftTurns} 番）: 依頼に触れた ${draftItemsCovered}/${draftItemsTotal}（${pct(draftItemsCovered, draftItemsTotal)}）・下書きの約束の種類 計 ${draftPromiseKinds}・人がまとめて約束した番で下書きの約束が少ない ${draftOneWhileHumanMulti}`);
  console.log(`ブレインが2段（約束の返信・1種類）にした番 ${twoStageTurns}・そのうち人は2種類以上を約束 ${twoStageOneKindHumanMulti}`);
  const show = SHOW === "wording" ? exWording : SHOW === "drop" ? exDrop : SHOW === "seq" ? exSeq : SHOW === "one" ? exOne : [];
  if (SHOW) { console.log(`\n== ${SHOW}`); for (const e of show) console.log("  " + e); }
}
main().catch((e) => { console.error(e); process.exit(1); });
