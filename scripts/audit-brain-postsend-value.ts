// scripts/audit-brain-postsend-value.ts — スタッフが約束を送った直後のブレイン再分析（send-line-message・brain_fresh）は何を足しているか（読むだけ・LLM なし）
//   2026-10-22: brain_fresh 月 約$110 のうち send-line-message の再分析（約束の送信の後）が月 約$24〜27。
//   1回ごとに: 窓（送信 -90秒〜+150秒）で新しく立った AIX要対応（aix_action_items）とやること（line_tasks・印 brain）、
//   その後のスタッフの AIX（aix_usage_logs）、お客様の次の発言（＝ふだんのブレインが回る時）を見て分ける:
//     役に立った … 立てた要対応と同じ AIX を、お客様の次の発言より前にスタッフが押した（次の分析を待っていたら遅れた）
//     重なった   … 立てたがスタッフが押したのはお客様の次の発言の後（次の分析でも間に合った）／押さなかった
//     何も出なかった … 新しい要対応もやることも無い
//   決まった計算（約束の並び promise-queue.buildPromiseQueue → nextPromiseAix）が同じ AIX を出すかも見る（安い道で足りる割合）。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-postsend-value.ts [--days=30] [--show=1]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { promisesInStaffText, buildPromiseQueue, nextPromiseAix, pickupNeedSignals, type QueueAixLog, type QueueMsg } from "../app/lib/promise-queue";
import { decidePostSendCheap, sameAixFamily, propertyInPlayFrom, customerPointedPropertyText, customerTurnBefore } from "../app/lib/brain-postsend-cheap";
import { claudeUsageUsd } from "../app/lib/llm-price";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const SHOW = arg("show") === "1";
const ms = (s: string) => Date.parse(s);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 100_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; await sleep(200); }
  return out;
}
const mask = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").replace(/[一-龯]{2,}(?:さん|様)/g, "〇〇さん").replace(/\d{3,}/g, "###").slice(0, 70);
const norm = (a: string | null | undefined) => (a === "property_check" ? "property_check_result" : String(a ?? ""));
const PROP_PAIR = new Set(["property_send", "property_recommendation"]);
const sameAix = (a: string, b: string) => norm(a) === norm(b) || (PROP_PAIR.has(norm(a)) && PROP_PAIR.has(norm(b)));

type L = { created_at: string; conversation_id: string | null; model: string | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; status: number | null };
type Item = { conversation_id: string; action: string; check_pattern: string | null; status: string; created_at: string; done_at: string | null; done_aix_type: string | null; dismissed_reason: string | null; resolution_note: string | null };
type Task = { conversation_id: string; task_type: string; status: string; created_at: string; completed_at: string | null; result_note: string | null };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Dec = { conversation_id: string; created_at: string; suggested_action: string | null; suggested_check_pattern: string | null; decision_source: string | null };
type Log = { conversation_id: string; aix_type: string | null; check_pattern: string | null; sent_at: string | null; created_at: string; estimate_sent: boolean | null; generated_text: string | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const llm = (await readAll<L>((f, t) => sb.from("llm_usage_logs").select("created_at, conversation_id, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, status")
    .eq("route", "/api/send-line-message").like("action", "brain_fresh%").gte("created_at", since).order("created_at").range(f, t)))
    .filter((r) => r.conversation_id && (r.status ?? 200) < 400);
  const usdAll = llm.reduce((s, r) => s + claudeUsageUsd(r), 0);
  // 1回の送信で2回呼ぶ（Claude への戻し等）物は1つにまとめる（同じ会話で2分以内）
  const runs: Array<{ cid: string; t: number; usd: number; calls: number }> = [];
  for (const r of llm) {
    const cid = r.conversation_id as string; const t = ms(r.created_at);
    const prev = runs.findLast((x) => x.cid === cid);
    if (prev && t - prev.t < 120_000) { prev.usd += claudeUsageUsd(r); prev.calls++; continue; }
    runs.push({ cid, t, usd: claudeUsageUsd(r), calls: 1 });
  }
  const ids = [...new Set(runs.map((r) => r.cid))];
  const decs: Dec[] = []; const msgs: Msg[] = []; const logs: Log[] = []; const items: Item[] = []; const tasks: Task[] = [];
  const from = new Date(ms(since) - 10 * 86_400_000).toISOString();
  for (let i = 0; i < ids.length; i += 40) {
    const g = ids.slice(i, i + 40);
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").in("conversation_id", g).gte("created_at", from).order("created_at").range(f, t)));
    logs.push(...await readAll<Log>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, created_at, estimate_sent, generated_text").in("conversation_id", g).gte("created_at", new Date(ms(since) - 90 * 86_400_000).toISOString()).not("aix_type", "is", null).order("created_at").range(f, t)));
    items.push(...await readAll<Item>((f, t) => sb.from("aix_action_items").select("conversation_id, action, check_pattern, status, created_at, done_at, done_aix_type, dismissed_reason, resolution_note").in("conversation_id", g).gte("created_at", since).order("created_at").range(f, t)));
    decs.push(...await readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, suggested_check_pattern, decision_source").in("conversation_id", g).gte("created_at", since).order("created_at").range(f, t)));
    tasks.push(...await readAll<Task>((f, t) => sb.from("line_tasks").select("conversation_id, task_type, status, created_at, completed_at, result_note").in("conversation_id", g).gte("created_at", since).order("created_at").range(f, t)));
  }
  const by = <T extends { conversation_id: string }>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { const a = m.get(x.conversation_id) ?? []; a.push(x); m.set(x.conversation_id, a); } return m; };
  const D = by(decs), M = by(msgs), G = by(logs), I = by(items), T = by(tasks);

  const cnt = { useful: 0, redundant: 0, unused: 0, none: 0, test: 0 };
  const usd = { useful: 0, redundant: 0, unused: 0, none: 0, test: 0 };
  // 決まった計算（約束の並び）が同じ AIX を出すか
  const det = { covered: 0, differs: 0, detNone: 0, detOnlyWhenBrainNone: 0, usefulCovered: 0, usefulMissed: 0 };
  const shown: string[] = [];
  let custBeforeText = "";
  const delays: number[] = [];
  const cheap = { saved: 0, usdSaved: 0, out: {} as Record<string, number>, taskLost: {} as Record<string, number>, taskExtra: 0, vsDecision: {} as Record<string, number>, usefulVs: {} as Record<string, number>, cross: {} as Record<string, number> };
  const queueVsText = { differ: 0, queueMissed: 0 };
  const srcBy: Record<string, Record<string, number>> = {};
  const usefulDet = { strict: 0, loose: 0, miss: 0, brainPromiseSrc: 0 };
  const agree = { total: 0, same: 0, differs: 0, detNone: 0 };
  const noneDecided: Record<string, number> = {}; let noneWithPending = 0;
  for (const r of runs) {
    if (isTestConversation(r.cid)) { cnt.test++; usd.test += r.usd; continue; }
    const ms_ = (M.get(r.cid) ?? []);
    const nextCust = ms_.find((m) => m.sender === "customer" && ms(m.created_at) > r.t);
    const ncT = nextCust ? ms(nextCust.created_at) : Infinity;
    const newItems = (I.get(r.cid) ?? []).filter((x) => ms(x.created_at) >= r.t - 90_000 && ms(x.created_at) <= r.t + 150_000 && !String(x.resolution_note ?? "").startsWith("rule:"));
    const newTasks = (T.get(r.cid) ?? []).filter((x) => x.result_note === "brain" && ms(x.created_at) >= r.t - 90_000 && ms(x.created_at) <= r.t + 150_000);
    const presses = (G.get(r.cid) ?? []).filter((l) => ms(l.sent_at ?? l.created_at) > r.t);
    // 決まった計算（送信の時点の会話＋AIX の記録だけ）
    const qMsgs: QueueMsg[] = ms_.filter((m) => ms(m.created_at) <= r.t && ms(m.created_at) >= r.t - 8 * 86_400_000).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated }));
    const qLogsAll: QueueAixLog[] = (G.get(r.cid) ?? []).filter((l) => ms(l.sent_at ?? l.created_at) <= r.t).map((l) => ({ aixType: l.aix_type ?? "", checkPattern: l.check_pattern, sentAt: l.sent_at ?? l.created_at, estimateSent: l.estimate_sent, text: l.generated_text }));
    const qLogs = qLogsAll.filter((l) => ms(l.sentAt) >= r.t - 8 * 86_400_000);
    const steps = buildPromiseQueue(qMsgs, qLogs, r.t, { windowDays: 7 });
    const pk = steps.find((s) => s.kind === "pickup" && s.status === "pending" && !s.watch);
    let need = null;
    if (pk) {
      const at = ms(pk.promisedAt);
      need = pickupNeedSignals(qMsgs.filter((m) => ms(m.createdAt) <= at), qLogs.filter((l) => ms(l.sentAt) <= at));
      if (need.noPropertiesSent && qLogsAll.some((l) => PROP_PAIR.has(l.aixType) && ms(l.sentAt) < at)) need = { ...need, noPropertiesSent: false };
    }
    const nx = nextPromiseAix(steps, { nowMs: r.t, need });
    // 送った通（3分以内のこちらの手打ち）の約束をそのまま並べる。⚠ buildPromiseQueue は通を全部読んでから AIX の送信を当てるため、
    //   前の同じ種類の約束が後で AIX で果たされていても、その間に送った同じ種類の新しい約束を「もう並んでいる」と飛ばす（1191b1 10/02 の確認の約束が消えた・queueVsText.queueMissed）
    const sentRun = ms_.filter((m) => m.sender !== "customer" && !m.is_aix_generated && ms(m.created_at) <= r.t && r.t - ms(m.created_at) <= 180_000);
    const textSteps = sentRun.flatMap((m) => promisesInStaffText(m.text, m.created_at));
    const nxText = nextPromiseAix(textSteps, { nowMs: r.t, need });
    const detAction = nxText ? nxText.next.action : (nx ? nx.next.action : null);
    if (nxText && nx && !sameAix(nxText.next.action, nx.next.action)) queueVsText.differ++; else if (nxText && !nx) queueVsText.queueMissed++;
    // 緩い比べ: 並びのまだの約束（探し続ける約束・順番の後ろも含む）のどれか
    const detLoose = [...textSteps.map((s) => s.action), ...textSteps.filter((s) => s.pickerKey).map((s) => String(s.pickerKey).split("/")[0])].concat(steps.filter((s) => s.status === "pending" && r.t - ms(s.promisedAt) <= 72 * 3600_000).map((s) => s.action));

    const dec = (D.get(r.cid) ?? []).find((d) => ms(d.created_at) >= r.t - 15_000 && ms(d.created_at) <= r.t + 180_000);
    const pendBefore = (I.get(r.cid) ?? []).filter((x) => ms(x.created_at) < r.t - 90_000 && (!x.done_at || ms(x.done_at) > r.t) && x.status !== "dismissed");
    const lastStaff = [...ms_].reverse().find((m) => m.sender !== "customer" && ms(m.created_at) <= r.t + 5_000);
    let cls: keyof typeof cnt;
    let why = "";
    if (!newItems.length && !newTasks.length) { cls = "none"; why = `判断:${dec?.suggested_action ?? "?"}/${dec?.decision_source ?? ""} 前から:${pendBefore.map((x) => x.action).join(",") || "-"}`; const k = dec ? (dec.suggested_action ?? "null") : "no_decision"; noneDecided[k] = (noneDecided[k] ?? 0) + 1; if (pendBefore.length) noneWithPending++; }
    else {
      const acts = newItems.map((x) => x.action);
      const press = presses.find((p) => acts.some((a) => sameAix(a, p.aix_type ?? "")));
      if (press && ms(press.sent_at ?? press.created_at) < ncT) { delays.push((ms(press.sent_at ?? press.created_at) - r.t) / 60_000); cls = "useful"; why = `押した ${press.aix_type}（お客様の次の発言より前）`; }
      else if (press) { cls = "redundant"; why = `押した ${press.aix_type}（お客様の次の発言の後）`; }
      else if (!newItems.length) { // やることだけ
        const doneT = newTasks.map((x) => (x.status === "completed" || x.status === "done") && x.completed_at ? ms(x.completed_at) : Infinity).reduce((a, b) => Math.min(a, b), Infinity);
        const done = doneT < ncT; if (done) delays.push((doneT - r.t) / 60_000);
        cls = done ? "useful" : "unused"; why = `やること ${newTasks.map((x) => `${x.task_type}:${x.status}`).join(",")}`;
      } else { cls = "unused"; why = `押さず（${newItems.map((x) => `${x.action}:${x.status}${x.dismissed_reason ? "/" + x.dismissed_reason : ""}`).join(",")}）`; }
      // 決まった計算との比べ（要対応を立てた番だけ）
      if (newItems.length) {
        if (detAction && acts.some((a) => sameAix(a, detAction))) { det.covered++; if (cls === "useful") det.usefulCovered++; }
        else if (detAction) { det.differs++; if (cls === "useful") det.usefulMissed++; }
        else { det.detNone++; if (cls === "useful") det.usefulMissed++; }
      }
    }
    if (cls === "none" && detAction) det.detOnlyWhenBrainNone++;
    cnt[cls]++; usd[cls] += r.usd;
    // ── 安い道（BRAIN_POSTSEND_CHEAP）を当てたら ──
    {
      const custBefore = custBeforeText = customerTurnBefore(ms_.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })), sentRun[0] ? ms(sentRun[0].created_at) : r.t);
      const propertyInPlay = propertyInPlayFrom(qMsgs, qLogsAll.some((l) => /^(?:property_send|property_recommendation|estimate_sheet)$/.test(l.aixType)));
      const customerPointedProperty = customerPointedPropertyText(custBefore);
      const open = pendBefore.filter((x) => !String(x.resolution_note ?? "").startsWith("rule:viewing_morning_greeting")).at(-1)?.action ?? null;
      const d = decidePostSendCheap({ sentSteps: textSteps, nowMs: r.t, need, openItemAction: open, isPostApply: false, propertyInPlay, customerPointedProperty });
      const brainItem = newItems[0]?.action ?? null;
      const pressedBeforeNext = (a: string) => presses.some((p) => sameAixFamily(a, p.aix_type) && ms(p.sent_at ?? p.created_at) < ncT);
      let o: string;
      if (d.kind === "full") { o = "full:" + d.reason; }
      else { cheap.usdSaved += r.usd; cheap.saved++;
        const cheapItem = d.kind === "insert" ? d.step.action : null;
        if (!brainItem && !cheapItem) o = "same_none";
        else if (brainItem && cheapItem && sameAixFamily(brainItem, cheapItem)) o = "same_item";
        else if (brainItem && !cheapItem) o = cls === "useful" ? "LOST_useful" : "lost_" + cls;
        else if (!brainItem && cheapItem) o = pressedBeforeNext(cheapItem) ? "extra_pressed" : "extra_unpressed";
        else o = cls === "useful" ? "WRONG_useful" : "wrong_" + cls;
        const brainTask = newTasks.length > 0; const cheapTask = d.kind === "insert" && d.tasks.length > 0;
        if (brainTask && !cheapTask) cheap.taskLost[cls] = (cheap.taskLost[cls] ?? 0) + 1;
        if (!brainTask && cheapTask) cheap.taskExtra++;
        // ブレインの判断（brain_decision_logs）と比べる（行の新規だけでは「同じ要対応を更新」「48時間超で登録しない」が見えない）
        const bd = dec ? (dec.suggested_action && dec.suggested_action !== "none" && !String(dec.decision_source ?? "").startsWith("no_aix") ? dec.suggested_action : null) : undefined;
        const ca = d.kind === "insert" ? d.step.action : (open ?? null);
        const k2 = bd === undefined ? "判断の記録なし" : !bd && !ca ? "同じ（AIX なし）" : bd && ca && sameAixFamily(bd, ca) ? "同じ AIX" : !bd ? "安い道だけ AIX（ブレインは返信）" : !ca ? "ブレインだけ AIX" : "違う AIX";
        cheap.vsDecision[k2] = (cheap.vsDecision[k2] ?? 0) + 1;
        if (SHOW && k2.startsWith("安い道だけ")) shown.push(`  VS ${dec?.suggested_action}/${dec?.decision_source} 安:${ca} 押:${presses.slice(0, 2).map((p) => p.aix_type + "@" + Math.round((ms(p.sent_at ?? p.created_at) - r.t) / 60000) + "m").join(",")} 次客:${Number.isFinite(ncT) ? Math.round((ncT - r.t) / 60000) + "m" : "-"} ｜${mask(custBeforeText)}｜送:${mask(lastStaff?.text)}`);
        if (cls === "useful") { const pa = presses.find((p) => ms(p.sent_at ?? p.created_at) < ncT)?.aix_type ?? ""; const k3 = ca && sameAixFamily(ca, pa) ? "同じ" : "外れ"; cheap.usefulVs[k3] = (cheap.usefulVs[k3] ?? 0) + 1; }
      }
      cheap.out[o] = (cheap.out[o] ?? 0) + 1;
      if (d.kind !== "full") { const k = (d.kind === "insert" ? d.step.kind : "skip") + "|脳item:" + (brainItem ?? "-") + "|脳task:" + (newTasks.map((x) => x.task_type).join(",") || "-") + "|" + cls; cheap.cross[k] = (cheap.cross[k] ?? 0) + 1; }
      if (SHOW && d.kind !== "full" && !/^same/.test(o)) shown.push(`  CHEAP ${o} 判断:${dec?.suggested_action ?? "?"}/${dec?.decision_source ?? ""} 押後:${presses.slice(0, 2).map((p) => p.aix_type + "@" + Math.round((ms(p.sent_at ?? p.created_at) - r.t) / 60000) + "m").join(",")} 次客:${Number.isFinite(ncT) ? Math.round((ncT - r.t) / 60000) + "m" : "-"} 脳:${brainItem ?? "-"} 安:${d.kind === "insert" ? d.step.action : d.kind} ｜送:${mask(lastStaff?.text)}`);
    }
    const src = String(dec?.decision_source ?? "none").replace(/[(（].*$/, "").replace(/^(promise|rule|llm|correction):.*/, "$1:*");
    srcBy[cls] = srcBy[cls] ?? {}; srcBy[cls][src] = (srcBy[cls][src] ?? 0) + 1;
    if (cls === "useful" && newItems.length) {
      const pressed = presses.find((p) => newItems.some((x) => sameAix(x.action, p.aix_type ?? "")))?.aix_type ?? "";
      if (detAction && sameAix(detAction, pressed)) usefulDet.strict++;
      else if (detLoose.some((a) => sameAix(a, pressed))) usefulDet.loose++;
      else usefulDet.miss++;
      if (String(dec?.decision_source ?? "").startsWith("promise:")) usefulDet.brainPromiseSrc++;
    }
    if (dec?.suggested_action && dec.suggested_action !== "none") {
      agree.total++;
      if (detAction && sameAix(detAction, dec.suggested_action)) agree.same++;
      else if (detAction) agree.differs++; else agree.detNone++;
    }
    if (SHOW) shown.push(`${cls.padEnd(9)} ${r.cid.slice(0, 6)} ${new Date(r.t).toISOString().slice(5, 16)} 決:${detAction ?? "-"} 脳:${newItems.map((x) => x.action + (x.check_pattern ? "/" + x.check_pattern : "")).join(",") || "-"} ${why} ｜送:${mask(lastStaff?.text)}`);
  }
  const live = runs.filter((r) => !isTestConversation(r.cid));
  console.log(JSON.stringify({ days: DAYS, calls: llm.length, runs: runs.length, liveRuns: live.length, usdAll: +usdAll.toFixed(2), usdPerMonth: +(usdAll * 30 / DAYS).toFixed(2), cnt, usd: Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, +v.toFixed(2)])), det, noneDecided, noneWithPending, srcBy, usefulDet, agree, queueVsText, cheap: { ...cheap, usdSaved: +cheap.usdSaved.toFixed(2) }, usefulDelayMin: (() => { const d = [...delays].sort((a, b) => a - b); const q = (p: number) => d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(p * d.length))]) : null; return { n: d.length, p25: q(0.25), p50: q(0.5), p75: q(0.75), under30: d.filter((x) => x < 30).length, over180: d.filter((x) => x > 180).length }; })() }, null, 1));
  if (SHOW) console.log(shown.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
