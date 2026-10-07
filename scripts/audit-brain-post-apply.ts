// scripts/audit-brain-post-apply.ts — 申込以降の番でブレインが何をしているかを数え、軽くする形（4つ）の費用と取りこぼしを見積もる（読むだけ・LLM なし）
//   2026-10-07 竹内「申込以降の会話で毎回動いているブレインの分析（月 約$50）を、軽くする」。
//   必ず残す: 審査落ち→別物件への切り替え（取りこぼし0が条件）・申込の手続きで要る AIX・取り消し/クレーム等の安全面・約束の台帳。
//   番ごとに: お客様の連投・決定論の印（自分の審査落ち・否決の語・こちらの否決の連絡の後・取り消し・クレーム・特定のお部屋・質問・手続きの語・お礼だけ・画像）、
//   brain_fresh の回数と費用、スタッフが見た判断（最初の返事の前の最後の判断）、スタッフの道（押した AIX／手打ち）。
//   形 (a) 印のある番だけブレインを回す の取りこぼし = 印が無いのに「スタッフが AIX を押した」番・「ブレインが AIX を出してスタッフが同じ AIX を押した」番。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-post-apply.ts [--since=2026-09-12] [--cost-since=2026-09-23] [--show=gate_miss|switch|all]
import { createClient } from "@supabase/supabase-js";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { isAckOnlyTurn } from "../app/lib/ack-topic-scope";
import { isOwnScreeningFailureTurn } from "../app/lib/screening-failed-switch";
import { detectSensitiveCase } from "../app/lib/sensitive-case";
import { customerPointsAtProperty } from "../app/lib/cost-question-scope";
import { claudeUsageUsd } from "../app/lib/llm-price";
import { decidePostApplyBrainGate } from "../app/lib/post-apply-brain-gate";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-09-12T00:00:00+09:00");
const COST_SINCE = arg("cost-since", "2026-09-23T00:00:00+09:00");
const SHOW = arg("show");
// --group=post（ステータスが申込中・審査中等＝軽くする対象）/ moved（申込へを押した後にステータスを提案中等へ戻した会話＝審査落ちの切り替えの期間・今まで通り）/ all
const GROUP = arg("group", "post");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (s: string) => Date.parse(s);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; await sleep(300); }
  return out;
}
type M = WindowMsg & { conversation_id: string };
type P = WindowPress & { conversation_id: string };
type D = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null; conversation_status: string | null };
type L = { created_at: string; conversation_id: string | null; route: string | null; model: string | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; duration_ms: number | null };
const POST = /^(?:applying|application|screening|contract|approved|closed_won)$/;
const PROP = /^property_(send|recommendation|pickup|search)$/;
const SWITCH_AIX = /^(?:property_(send|recommendation|pickup|search)|property_check_result|acknowledge_check)$/;
const STAFF_FAIL_RE = /否決|審査[^。！!？?\n]{0,10}(?:落ち|通ら|NG|ダメ|だめ|通りません)|承認(?:が)?(?:下りず|おりず|頂けず|いただけず)|ご期待に添え/;
const PROCEDURE_RE = /書類|本人確認|免許|マイナンバー|保険証|申込書|申込フォーム|入居日|契約|鍵|振込|振り込|入金|初期費用|請求|重要事項|重説|保証会社|緊急連絡先|連帯保証|審査|在籍|勤務先|口座|引き落とし|日割/;
const sameAix = (a: string, b: string) => a === b || (PROP.test(a) && PROP.test(b));
const ci = (k: number, n: number) => { if (!n) return "-"; const p = k / n; return `${Math.round(p * 100)}%±${Math.round(1.96 * Math.sqrt((p * (1 - p)) / n) * 100)}（${k}/${n}）`; };

(async () => {
  const decs = await readAll<D>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, decision_source, conversation_status").gte("created_at", SINCE).order("created_at").range(f, t));
  const llm = await readAll<L>((f, t) => sb.from("llm_usage_logs").select("created_at, conversation_id, route, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, duration_ms")
    .gte("created_at", COST_SINCE).eq("env", "production").eq("action", "brain_fresh").gte("status", 1).lte("status", 399).order("created_at").range(f, t));
  const convs = [...new Set(decs.map((d) => d.conversation_id).filter((c) => !isTestConversation(c)))];
  const msgs: M[] = [], presses: P[] = [];
  for (let i = 0; i < convs.length; i += 60) {
    const ids = convs.slice(i, i + 60);
    msgs.push(...await readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").in("conversation_id", ids).gte("created_at", new Date(ms(SINCE) - 5 * 86_400_000).toISOString()).order("created_at").order("id").range(f, t)));
    presses.push(...await readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", ids).gte("created_at", new Date(ms(SINCE) - 90 * 86_400_000).toISOString()).not("aix_type", "is", null).order("created_at").range(f, t)));
    await sleep(400);
  }
  const by = <T extends { conversation_id: string | null }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { const k = r.conversation_id ?? ""; if (!mp.has(k)) mp.set(k, []); mp.get(k)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses), dBy = by(decs), lBy = by(llm);
  const costDays = (Date.now() - ms(COST_SINCE)) / 86_400_000;
  type Row = { conv: string; at: string; text: string; flags: string[]; calls: number; callsMid: number; callsAfterStaff: number; usd: number; staff: string[]; own: boolean; brainPath: string | null; brainSrc: string | null; agreeAix: boolean; anyPress: boolean; switchTurn: boolean; status: string | null; gateRun: boolean; gateReason: string };
  const rows: Row[] = [];
  const midGapSec: number[] = [], staffLagMin: number[] = [];
  const docSkip = { calls: 0, usd: 0, judged: 0, okBefore: 0, okAfter: 0, gained: 0, lost: [] as string[] };
  for (const conv of convs) {
    const ms_ = (mBy.get(conv) ?? []).sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const ps = (pBy.get(conv) ?? []).sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const ds = (dBy.get(conv) ?? []).filter((d) => d.analyzed_msg_ts).sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const ls = (lBy.get(conv) ?? []).sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const callTs = ls.map((l) => { const d = ds.find((x) => ms(x.created_at) >= ms(l.created_at) - 2000 && ms(x.created_at) - ms(l.created_at) <= 120_000); return { l, ts: d?.analyzed_msg_ts ?? null }; });
    const applyAt = ps.find((p) => p.aix_type === "application_push")?.created_at ?? null;
    for (let i = 0; i < ms_.length; i++) {
      if (ms_[i].sender !== "customer" || (i > 0 && ms_[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < ms_.length && ms_[j + 1].sender === "customer") j++;
      const start = ms_[i].created_at, end = ms_[j].created_at;
      if (ms(end) < ms(SINCE)) continue;
      const turnDecs = ds.filter((d) => ms(d.analyzed_msg_ts!) >= ms(start) - 1000 && ms(d.analyzed_msg_ts!) <= ms(end) + 1000);
      const turnCalls = callTs.filter((c) => c.ts && ms(c.ts) >= ms(start) - 1000 && ms(c.ts) <= ms(end) + 1000);
      if (!turnDecs.length && !turnCalls.length) continue;
      const status = turnDecs[turnDecs.length - 1]?.conversation_status ?? null;
      const realPost = POST.test(status ?? "");
      const moved = !realPost && !!applyAt && ms(applyAt) <= ms(end);
      if (GROUP === "post" ? !realPost : GROUP === "moved" ? !moved : !(realPost || moved)) continue;
      const text = ms_.slice(i, j + 1).map((m) => m.text ?? "").join("\n");
      const w = staffWindowOf({ customerTurnAt: end, msgs: ms_, presses: ps });
      const bp = [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))];
      const bt = w.texts.filter((x) => x.burst).map((x) => x.text).join("\n");
      const allPress = [...new Set(w.presses.map((p) => p.aix_type))];
      const staff = bp.length ? bp : bt ? ["reply"] : [];
      // 印
      const flags: string[] = [];
      if (isOwnScreeningFailureTurn(text)) flags.push("own_fail");
      const sens = detectSensitiveCase(text);
      if (sens === "審査否決") flags.push("reject_word"); else if (sens === "キャンセル・リスケ") flags.push("cancel"); else if (sens === "クレーム") flags.push("claim");
      const prevStaff = ms_.slice(0, i).filter((m) => m.sender !== "customer" && ms(m.created_at) > ms(start) - 3 * 86_400_000);
      if (prevStaff.some((m) => STAFF_FAIL_RE.test(m.text ?? ""))) flags.push("after_staff_fail");
      if (customerPointsAtProperty(text) || /https?:\/\//.test(text)) flags.push("property_ref");
      if (/\[画像\]/.test(text)) flags.push("image");
      if (/[？?]/.test(text)) flags.push("question");
      if (PROCEDURE_RE.test(text)) flags.push("procedure");
      // お客様が自分で書いた文（画像・ファイルの読み取りと申込フォームの記入を除く）での質問・特定のお部屋
      const ownText = ms_.slice(i, j + 1).map((m) => m.text ?? "").filter((t) => !/^\s*\[(?:画像|ファイル|動画)\]/.test(t) && !/【[^】]*(?:欄|記入)】|フリガナ|生年月日/.test(t)).join("\n");
      if (/[？?]/.test(ownText)) flags.push("own_question");
      if (customerPointsAtProperty(ownText) || /https?:\/\//.test(ownText)) flags.push("own_property");
      if (isAckOnlyTurn(text) || /^(?:\[スタンプ\]\s*)+$/.test(text.trim())) flags.push("ack");
      const preDecs = turnDecs.filter((d) => ms(d.analyzed_msg_ts!) >= ms(end) - 1000 && (!w.staffFirstAt || ms(d.created_at) < ms(w.staffFirstAt)));
      // 形(a') 呼び出しごと: 見た発言が書類の画像・ファイル・申込フォームの記入だけ（危ない印の無い番）なら LLM を回さない
      {
        const msgAt = (ts: string) => ms_.find((m) => Math.abs(ms(m.created_at) - ms(ts)) < 1000);
        const isDoc = (ts: string | null) => { const m = ts ? msgAt(ts) : null; const t = m?.text ?? ""; return !!m && (/^\s*\[(?:画像|ファイル|動画)\]/.test(t) || /【[^】]*(?:欄|記入)】|フリガナ|生年月日/.test(t)); };
        const danger = flags.some((f) => ["own_fail", "reject_word", "after_staff_fail", "cancel", "claim"].includes(f));
        const inCost = ms(end) >= ms(COST_SINCE);
        for (const c of turnCalls) { if (!danger && isDoc(c.ts)) { docSkip.calls++; if (inCost) docSkip.usd += claudeUsageUsd(c.l); } }
        // スタッフが見る判断: 書類の発言を見た判断を除いた、返事の前の最後の判断
        const allPre = turnDecs.filter((d) => !w.staffFirstAt || ms(d.created_at) < ms(w.staffFirstAt));
        const keptPre = danger ? allPre : allPre.filter((d) => !isDoc(d.analyzed_msg_ts));
        const lastAll = allPre[allPre.length - 1] ?? null, lastKept = keptPre[keptPre.length - 1] ?? null;
        const pth = (d: D | null) => (d ? (d.suggested_reply_mode === "aix" && d.suggested_action ? d.suggested_action : "reply") : null);
        const st = (() => { const bp2 = [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))]; return bp2.length ? bp2 : w.texts.some((x) => x.burst) ? ["reply"] : []; })();
        const ok = (p: string | null) => !!p && (p === "reply" ? st[0] === "reply" : st.some((s) => sameAix(s, p)));
        if (st.length && lastAll) { docSkip.judged++; if (ok(pth(lastAll))) docSkip.okBefore++; if (ok(pth(lastKept))) docSkip.okAfter++; if (ok(pth(lastAll)) && !ok(pth(lastKept))) docSkip.lost.push(`${conv.slice(0, 8)} ${end.slice(5, 16)} 今=${pth(lastAll)} 後=${pth(lastKept) ?? "（判断なし）"} 人=${st.join(",")}`); if (!ok(pth(lastAll)) && ok(pth(lastKept))) docSkip.gained++; }
      }
      // 10/07 竹内さんの決定（形 (a)）: 申込中・審査中は否決・取り消し・クレームの時だけ回す（app/lib/post-apply-brain-gate.ts）
      const lastPush = [...ps].filter((p) => p.aix_type === "application_push" && ms(p.created_at) <= ms(end)).pop()?.created_at ?? null;
      const gate = decidePostApplyBrainGate({ status: "applying", msgs: ms_.slice(Math.max(0, j - 39), j + 1), applicationPushAt: lastPush, env: {} });
      const last = preDecs[preDecs.length - 1] ?? null;
      const brainPath = last ? (last.suggested_reply_mode === "aix" && last.suggested_action ? last.suggested_action : "reply") : null;
      const agreeAix = !!brainPath && brainPath !== "reply" && bp.some((a) => sameAix(a, brainPath));
      // 審査落ち→別物件の切り替えの番: 否決の印のある番・こちらの否決の連絡の後の番で、窓の中で別物件の AIX を押した／ブレインが別物件の AIX を出した
      const failCtx = flags.some((f) => f === "own_fail" || f === "reject_word" || f === "after_staff_fail");
      const switchTurn = failCtx && (allPress.some((a) => SWITCH_AIX.test(a)) || (!!brainPath && SWITCH_AIX.test(brainPath)));
      for (const c of turnCalls.filter((x) => ms(x.ts!) < ms(end) - 1000)) {
        const nx = ms_.slice(i, j + 1).find((m) => ms(m.created_at) > ms(c.ts!) + 500);
        if (nx) midGapSec.push((ms(nx.created_at) - ms(c.ts!)) / 1000);
      }
      if (w.staffFirstAt) staffLagMin.push((ms(w.staffFirstAt) - ms(end)) / 60000);
      rows.push({ conv, at: end, text: text.slice(0, 140), flags, calls: turnCalls.length, callsMid: turnCalls.filter((c) => ms(c.ts!) < ms(end) - 1000).length,
        callsAfterStaff: turnCalls.filter((c) => w.staffFirstAt && ms(c.l.created_at) > ms(w.staffFirstAt)).length, usd: turnCalls.reduce((a, c) => a + claudeUsageUsd(c.l), 0),
        staff, own: ownText.trim().length > 0, brainPath, brainSrc: last?.decision_source ?? null, agreeAix, anyPress: bp.length > 0, switchTurn, status, gateRun: gate.run, gateReason: gate.reason });
    }
  }
  const costRows = rows.filter((r) => ms(r.at) >= ms(COST_SINCE));
  const calls = costRows.reduce((a, r) => a + r.calls, 0), usd = costRows.reduce((a, r) => a + r.usd, 0);
  console.log(`[group=${GROUP}] `);
  console.log(`申込以降の番 ${rows.length}（会話 ${new Set(rows.map((r) => r.conv)).size}）｜費用の期間（${COST_SINCE.slice(0, 10)}〜 ${costDays.toFixed(1)}日）: 番 ${costRows.length}・brain_fresh ${calls}回 $${usd.toFixed(2)}（30日 $${((usd / costDays) * 30).toFixed(0)}）`);
  console.log(`  うち 連投の途中 ${costRows.reduce((a, r) => a + r.callsMid, 0)}回・スタッフの返事の後 ${costRows.reduce((a, r) => a + r.callsAfterStaff, 0)}回・1番あたり ${(calls / Math.max(1, costRows.length)).toFixed(2)}回`);
  {
    const g = [...midGapSec].sort((a, b) => a - b), q = (x: number) => g.filter((v) => v <= x).length;
    const lag = [...staffLagMin].sort((a, b) => a - b), pq = (p: number) => (lag.length ? lag[Math.floor(p * (lag.length - 1))].toFixed(1) : "-");
    console.log(`  連投の途中の呼び出し ${g.length}回: 見た発言から次の発言まで ≤30秒 ${q(30)}・≤1分 ${q(60)}・≤2分 ${q(120)}・≤3分 ${q(180)}・≤5分 ${q(300)}・≤10分 ${q(600)}`);
    console.log(`  スタッフの最初の返事まで（分・最後の発言から）: p25 ${pq(0.25)}・p50 ${pq(0.5)}・p75 ${pq(0.75)}・3分以内 ${lag.filter((x) => x <= 3).length}/${lag.length}・5分以内 ${lag.filter((x) => x <= 5).length}`);
  }
  const st = new Map<string, number>(); for (const r of rows) st.set(r.status ?? "(null)", (st.get(r.status ?? "(null)") ?? 0) + 1);
  console.log(`  ステータス: ${[...st].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  // スタッフの道とブレインの判断
  const judged = rows.filter((r) => r.staff.length && r.brainPath);
  const sp = new Map<string, number>(); for (const r of rows.filter((x) => x.staff.length)) for (const s of r.staff) sp.set(s, (sp.get(s) ?? 0) + 1);
  const bpm = new Map<string, number>(); for (const r of rows.filter((x) => x.brainPath)) bpm.set(r.brainPath!, (bpm.get(r.brainPath!) ?? 0) + 1);
  console.log(`\n■ スタッフの道（返事のあった ${rows.filter((r) => r.staff.length).length}番）: ${[...sp].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}｜返事なし ${rows.filter((r) => !r.staff.length).length}番`);
  console.log(`■ ブレインの判断（スタッフが見た判断 ${rows.filter((r) => r.brainPath).length}番）: ${[...bpm].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  const okPath = (r: Row) => (r.brainPath === "reply" ? r.staff[0] === "reply" : r.staff.some((s) => sameAix(s, r.brainPath!)));
  console.log(`■ 道の一致 ${ci(judged.filter(okPath).length, judged.length)}｜ブレインが AIX を出した番 ${judged.filter((r) => r.brainPath !== "reply").length} → スタッフが同じ AIX を押した ${judged.filter((r) => r.agreeAix).length}｜ブレイン=返信 ${judged.filter((r) => r.brainPath === "reply").length} → スタッフが AIX を押した ${judged.filter((r) => r.brainPath === "reply" && r.anyPress).length}`);
  const src = new Map<string, number>(); for (const r of judged) { const k = (r.brainSrc ?? "llm/null").replace(/\(.*$/, ""); src.set(k, (src.get(k) ?? 0) + 1); }
  console.log(`  判断の出所: ${[...src].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join("・")}`);
  // 印ごと
  console.log("\n■ 印ごと（番・呼び出し・$・スタッフが AIX を押した番・ブレインの AIX が当たった番）");
  for (const f of ["own_fail", "reject_word", "after_staff_fail", "cancel", "claim", "property_ref", "image", "question", "procedure", "ack", "(印なし)"]) {
    const rs = costRows.filter((r) => (f === "(印なし)" ? r.flags.length === 0 : r.flags.includes(f)));
    const all = rows.filter((r) => (f === "(印なし)" ? r.flags.length === 0 : r.flags.includes(f)));
    console.log(`  ${f.padEnd(17)} 番 ${String(all.length).padStart(3)}｜費用期間 ${rs.length}番 ${rs.reduce((a, r) => a + r.calls, 0)}回 $${rs.reduce((a, r) => a + r.usd, 0).toFixed(2)}｜押した ${all.filter((r) => r.anyPress).length}・当たり ${all.filter((r) => r.agreeAix).length}`);
  }
  // 審査落ち→別物件の切り替え
  const sw = rows.filter((r) => r.switchTurn);
  console.log(`\n■ 審査落ち→別物件の切り替えの番 ${sw.length}（会話 ${new Set(sw.map((r) => r.conv)).size}）・否決の文脈の番（own_fail/reject_word/after_staff_fail）${rows.filter((r) => r.flags.some((f) => /fail|reject/.test(f))).length}`);
  // 形 (a): 印のある番だけ回す
  const GATES: Array<[string, (r: Row) => boolean]> = [
    ["A: 否決の文脈・取り消し・クレーム だけ", (r) => r.flags.some((f) => ["own_fail", "reject_word", "after_staff_fail", "cancel", "claim"].includes(f))],
    ["B: A＋特定のお部屋・画像", (r) => r.flags.some((f) => ["own_fail", "reject_word", "after_staff_fail", "cancel", "claim", "property_ref", "image"].includes(f))],
    ["C: B＋質問", (r) => r.flags.some((f) => ["own_fail", "reject_word", "after_staff_fail", "cancel", "claim", "property_ref", "image", "question"].includes(f))],
    ["D: C＋手続きの語", (r) => r.flags.some((f) => f !== "ack")],
    ["G: 否決の文脈・取り消し・クレーム＋お客様が自分で書いた質問・特定のお部屋（書類の画像・申込フォームだけの番は回さない）", (r) => r.flags.some((f) => ["own_fail", "reject_word", "after_staff_fail", "cancel", "claim", "own_question", "own_property"].includes(f))],
    ["H: G＋お礼だけ以外の自分の文（書類・フォームだけの番だけ回さない）", (r) => r.flags.some((f) => ["own_fail", "reject_word", "after_staff_fail", "cancel", "claim", "own_question", "own_property"].includes(f)) || (!!r.own && !r.flags.includes("ack"))],
    ["F: 決定（post-apply-brain-gate＝否決・取り消し・クレーム・迷い・別の物件の語＋否決の後は全部）", (r) => r.gateRun],
    ["E: お礼・スタンプだけの番は回さない（他は全部）", (r) => !(r.flags.length === 1 && r.flags[0] === "ack")],
  ];
  console.log("\n■ 形(a) 印のある番だけブレインを回す: 残る呼び出し・$（30日）｜取りこぼし: 切り替えの番／ブレインの AIX が当たった番／スタッフが AIX を押した番");
  for (const [name, g] of GATES) {
    const keep = costRows.filter(g);
    const kUsd = keep.reduce((a, r) => a + r.usd, 0);
    const missSw = sw.filter((r) => !g(r)), missAgree = rows.filter((r) => r.agreeAix && !g(r)), missPress = rows.filter((r) => r.anyPress && !g(r));
    console.log(`  ${name}: 回す ${keep.reduce((a, r) => a + r.calls, 0)}/${calls}回・$${((kUsd / costDays) * 30).toFixed(0)}/月（今 $${((usd / costDays) * 30).toFixed(0)}）｜切り替え ${missSw.length}/${sw.length}・当たり ${missAgree.length}/${rows.filter((r) => r.agreeAix).length}・押した ${missPress.length}/${rows.filter((r) => r.anyPress).length}`);
    if (SHOW === "gate_miss") for (const r of missAgree.slice(0, 8)) console.log(`     × ${r.conv.slice(0, 8)} ${r.at.slice(5, 16)} [${r.flags.join(",")}] 客「${r.text.replace(/\n/g, "⏎").slice(0, 50)}」 ブレイン=${r.brainPath}(${r.brainSrc}) 人=${r.staff.join(",")}`);
  }
  console.log(`
■ 形(a') 書類の画像・ファイル・申込フォームの記入を見る呼び出しだけ回さない（否決・取り消し・クレームの番は回す）: 減る ${docSkip.calls}回・費用期間 ${docSkip.usd.toFixed(2)}（30日 ${((docSkip.usd / costDays) * 30).toFixed(1)}）｜道の一致 ${docSkip.okBefore}→${docSkip.okAfter}/${docSkip.judged}（下がる ${docSkip.lost.length}・上がる ${docSkip.gained}）`);
  for (const x of docSkip.lost) console.log(`     ↓ ${x}`);
  // 形(d) 回数を減らす: 連投の途中（10秒以内）・お礼
  if (SHOW === "image") for (const r of rows.filter((x) => x.flags.includes("image"))) console.log(`  画像 ${r.conv.slice(0, 8)} ${r.at.slice(5, 16)} 呼び出し${r.calls}（途中${r.callsMid}） [${r.flags.join(",")}] 客「${r.text.replace(/\n/g, "⏎").slice(0, 70)}」 ブレイン=${r.brainPath}(${r.brainSrc}) 人=${r.staff.join(",")}${r.agreeAix ? " ★当たり" : ""}`);
  if (SHOW === "switch" || SHOW === "all") for (const r of sw) console.log(`  切替 ${r.conv.slice(0, 8)} ${r.at.slice(0, 16)} 状態=${r.status} 関門=${r.gateReason} [${r.flags.join(",")}] 客「${r.text.replace(/\n/g, "⏎").slice(0, 60)}」 ブレイン=${r.brainPath}(${r.brainSrc}) 人=${r.staff.join(",")}`);
})().catch((e) => { console.error(e); process.exit(1); });
