// scripts/audit-brain-cost-levers.ts — ブレインの費用の3つの手（回数・場面ごとのモデル・キャッシュ）を本番の記録で測る（読むだけ・LLM なし）
//   2026-10-07 竹内「この3つもはかって！！質は絶対に落ちないようにする必要がある」
//   ①回数: お客様の番（連投のまとまり）ごとに brain_fresh の呼び出しを数え、型（短いお礼・スタンプだけ・閉じた話題のお礼・連投の途中・スタッフ送信の後）に分ける。
//      質の物差し＝スタッフが見た判断（スタッフの最初の返事より前に作られた最後の判断）とスタッフの道（返信か・どの AIX か・2段の約束の決まりどおりを含む）の一致。
//      「回さない」代わりの判断の候補 2つ（前の番の判断をそのまま／いつも返信）の一致と並べる（番を単位に 95% の幅）。
//   ②場面ごと: 場面ごとに LLM が決めた（decision_source=llm/null）割合と決定論が決めた割合・LLM の判断の一致。
//   ③キャッシュ: brain_fresh の費用の内訳（素の入力・5分書き・1h書き・読み・出力）・会話専用ブロックが読まれた割合・同じ会話の次の呼び出しまでの間隔・1h の全書き直しの前の空き。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-cost-levers.ts [--since=2026-09-23] [--out=<jsonl>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene, type ReplyScene } from "../app/lib/reply-scene";
import { isAckOnlyTurn, resolveAckTopicScope } from "../app/lib/ack-topic-scope";
import { claudeUsageUsd } from "../app/lib/llm-price";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-09-23T00:00:00+09:00");
const OUT = arg("out");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type M = WindowMsg & { conversation_id: string; id: string };
type P = WindowPress & { conversation_id: string };
type D = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; decision_source: string | null; conversation_status: string | null; analysis_mode: string | null };
type L = { id: number; duration_ms: number | null; created_at: string; conversation_id: string | null; route: string | null; model: string | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number };
// 本番 DB の負荷（10/07 朝に止まった）: 1000行ずつ・間を空ける
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; await sleep(300); }
  return out;
}
const POST = /^(?:applying|application|screening|contract|approved|closed_won)$/;
const PROP = /^property_(send|recommendation|pickup|search)$/;
const sameAix = (a: string, b: string) => a === b || (PROP.test(a) && PROP.test(b));
const ms = (s: string) => Date.parse(s);
type Dec = { action: string | null; mode: string | null; src: string | null } | null;
/** 道の一致（audit-r3-replay-score の pathOk2 と同じ: 2段の約束の返信＋スタッフがその約束の AIX を押した＝決まりどおり） */
function pathOk(dec: Dec, staff: string[]): boolean {
  const brain = dec && dec.mode === "aix" && dec.action ? dec.action : "reply";
  if (brain === "reply" ? staff[0] === "reply" : staff.some((s) => sameAix(s, brain))) return true;
  const m = /two_stage_promise\((pickup|check|check_question|estimate)\)/.exec(dec?.src ?? "");
  if (!m || dec?.mode === "aix") return false;
  const k = m[1];
  return staff.some((a) => (k === "pickup" && /^property_(send|recommendation|search)$/.test(a)) || (k.startsWith("check") && (a === "property_check_result" || a === "acknowledge_check")) || (k === "estimate" && a === "estimate_sheet"));
}
const isLlmSrc = (s: string | null) => !s || s === "llm" || s.startsWith("llm");
const ci = (k: number, n: number) => { if (!n) return "-"; const p = k / n; const h = 1.96 * Math.sqrt((p * (1 - p)) / n); return `${Math.round(p * 100)}%±${Math.round(h * 100)}`; };

(async () => {
  console.log(`期間: ${SINCE}〜（本番・テストの会話を除く・申込以降を除く）`);
  const llm = await readAll<L>((f, t) => sb.from("llm_usage_logs").select("id, created_at, conversation_id, route, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, duration_ms")
    .gte("created_at", SINCE).eq("env", "production").eq("action", "brain_fresh").gte("status", 1).lte("status", 399).order("created_at").range(f, t));
  const decs = await readAll<D>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, decision_source, conversation_status, analysis_mode")
    .gte("created_at", SINCE).order("created_at").range(f, t));
  const convs = [...new Set(decs.map((d) => d.conversation_id).filter((c) => !isTestConversation(c)))];
  const msgs: M[] = []; const presses: P[] = [];
  const mSince = new Date(ms(SINCE) - 3 * 86_400_000).toISOString();
  for (let i = 0; i < convs.length; i += 60) {
    const ids = convs.slice(i, i + 60);
    msgs.push(...await readAll<M>((f, t) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated").in("conversation_id", ids).gte("created_at", mSince).order("created_at").order("id").range(f, t)));
    presses.push(...await readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", ids).gte("created_at", new Date(ms(SINCE) - 60 * 86_400_000).toISOString()).not("aix_type", "is", null).order("created_at").range(f, t)));
    await sleep(400);
  }
  console.log(`読んだ: brain_fresh ${llm.length}・判断 ${decs.length}・会話 ${convs.length}・メッセージ ${msgs.length}・押下 ${presses.length}`);
  const by = <T extends { conversation_id: string | null }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { const k = r.conversation_id ?? ""; if (!mp.has(k)) mp.set(k, []); mp.get(k)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses), dBy = by(decs), lBy = by(llm);

  // ── ③ キャッシュ ──
  {
    const usd = (r: L) => claudeUsageUsd(r);
    const tot = llm.reduce((a, r) => a + usd(r), 0);
    const part = (f: (r: L) => number) => llm.reduce((a, r) => a + f(r), 0) / 1e6;
    const uin = part((r) => r.input_uncached * 2), w5 = part((r) => (r.cache_write_5m ?? 0) * 2.5), w1 = part((r) => (r.cache_write_1h ?? 0) * 4), rd = part((r) => r.cache_read * 0.2), out = part((r) => r.output_tokens * 10);
    const days = (Date.now() - ms(SINCE)) / 86_400_000;
    console.log(`\n■③ キャッシュ（brain_fresh ${llm.length}回・${days.toFixed(1)}日・DB の単価で $${tot.toFixed(2)}＝1回 $${(tot / llm.length).toFixed(4)}・30日換算 $${((tot / days) * 30).toFixed(0)}）`);
    console.log(`  内訳: 素の入力 $${uin.toFixed(2)}（${Math.round((uin / tot) * 100)}%）・5分書き $${w5.toFixed(2)}（${Math.round((w5 / tot) * 100)}%）・1h書き $${w1.toFixed(2)}（${Math.round((w1 / tot) * 100)}%）・読み $${rd.toFixed(2)}（${Math.round((rd / tot) * 100)}%）・出力 $${out.toFixed(2)}（${Math.round((out / tot) * 100)}%）`);
    // 同じ会話の次の brain_fresh までの間隔と、会話専用ブロック（5分）が読まれたか
    const gaps: number[] = []; let convHit = 0, convWrite = 0, wasted5 = 0, w5tok = 0;
    const rew: Array<{ gapMin: number | null; prevAny: number | null }> = [];
    const allSorted = [...llm].sort((a, b) => ms(a.created_at) - ms(b.created_at));
    for (let i = 0; i < allSorted.length; i++) {
      const r = allSorted[i];
      if ((r.cache_write_1h ?? 0) > 30000) rew.push({ gapMin: null, prevAny: i > 0 ? Math.round((ms(r.created_at) - ms(allSorted[i - 1].created_at)) / 60000) : null });
    }
    for (const [, rows] of lBy) {
      const s = [...rows].sort((a, b) => ms(a.created_at) - ms(b.created_at));
      for (let i = 0; i < s.length; i++) {
        const r = s[i];
        const static0 = 39000; // system 2ブロック（brain-warm の読み 39.6〜41.4k）
        if ((r.cache_write_5m ?? 0) > 0) { convWrite++; w5tok += r.cache_write_5m; }
        if (r.cache_read > static0 + 4500) convHit++;
        if (i + 1 < s.length) { const g = (ms(s[i + 1].created_at) - ms(r.created_at)) / 60000; gaps.push(g); if ((r.cache_write_5m ?? 0) > 0 && g > 5) wasted5++; }
        else if ((r.cache_write_5m ?? 0) > 0) wasted5++;
      }
    }
    const q = (p: number) => { const g = [...gaps].sort((a, b) => a - b); return g.length ? g[Math.floor(p * (g.length - 1))].toFixed(1) : "-"; };
    console.log(`  同じ会話の次の brain_fresh まで（分）: p10 ${q(0.1)}・p25 ${q(0.25)}・p50 ${q(0.5)}・p75 ${q(0.75)}｜5分以内 ${gaps.filter((g) => g <= 5).length}/${gaps.length}・60分以内 ${gaps.filter((g) => g <= 60).length}`);
    console.log(`  会話専用ブロック（5分）: 書いた ${convWrite}回（平均 ${Math.round(w5tok / Math.max(1, convWrite))}トークン）・読めた（読み>${39000 + 4500}）${convHit}回・次まで5分超で無駄になった書き ${wasted5}回`);
    const keepNow = w5tok * 2.5 / 1e6, noMark = w5tok * 2 / 1e6;
    console.log(`    → 印を外すと 5分書きの割増 $${(keepNow - noMark).toFixed(2)} が浮き、読めていた ${convHit}回×約3.1k の割引（×1.8）を失う ≈ $${(convHit * 3100 * 1.8 / 1e6).toFixed(2)}`);
    console.log(`  system（1h）の全書き直し（1h書き>30k）: ${rew.length}回・$${(rew.length * 36000 * 4 / 1e6).toFixed(2)}｜直前の brain_fresh（どの会話でも）からの空き（分）: ${rew.map((x) => x.prevAny).join(",")}`);
  }

  // ── ① 回数・② 場面 ──
  type Row = { conv: string; at: string; scene: ReplyScene; cls: string; text: string; calls: number; callsPre: number; callsPost: number; callsMid: number; usd: number;
    staff: string[]; brain: Dec; prev: Dec; okBrain: boolean; okPrev: boolean; okReply: boolean; llmSrc: boolean };
  const rows: Row[] = [];
  const skipped = { post: 0, postCalls: 0, postUsd: 0, postMid: 0, postAfterStaff: 0, open: 0, noStaff: 0, noDec: 0 };
  const relook: Array<{ okFirst: boolean; okLast: boolean; same: boolean; hours: number }> = [];
  const midGaps: Array<{ fromMsg: number; fromCall: number; fromStart: number; scene: string; route: string }> = [];
  const postMidGaps: typeof midGaps = [];
  const dupPre: Array<{ gapSec: number; route: string; img: boolean }> = [];
  const callUsd = (r: L) => claudeUsageUsd(r);
  for (const conv of convs) {
    const ms_ = (mBy.get(conv) ?? []).sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const ps = pBy.get(conv) ?? [];
    const ds = (dBy.get(conv) ?? []).filter((d) => d.analyzed_msg_ts).sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const ls = (lBy.get(conv) ?? []).sort((a, b) => ms(a.created_at) - ms(b.created_at));
    // 呼び出し → その後 120 秒以内の最初の判断の analyzed_msg_ts（無ければ null）
    const callTs = ls.map((l) => { const d = ds.find((x) => ms(x.created_at) >= ms(l.created_at) - 2000 && ms(x.created_at) - ms(l.created_at) <= 120_000); return { l, ts: d?.analyzed_msg_ts ?? null }; });
    const applyAt = ps.find((p) => p.aix_type === "application_push")?.created_at ?? null;
    // お客様の番（連投のまとまり）
    for (let i = 0; i < ms_.length; i++) {
      if (ms_[i].sender !== "customer") continue;
      if (i > 0 && ms_[i - 1].sender === "customer") continue;
      let j = i; while (j + 1 < ms_.length && ms_[j + 1].sender === "customer") j++;
      const start = ms_[i].created_at, end = ms_[j].created_at;
      if (ms(end) < ms(SINCE)) continue;
      const w = staffWindowOf({ customerTurnAt: end, msgs: ms_, presses: ps });
      const turnDecs = ds.filter((d) => ms(d.analyzed_msg_ts!) >= ms(start) - 1000 && ms(d.analyzed_msg_ts!) <= ms(end) + 1000);
      const turnCalls = callTs.filter((c) => c.ts && ms(c.ts) >= ms(start) - 1000 && ms(c.ts) <= ms(end) + 1000);
      if (!turnCalls.length && !turnDecs.length) continue;
      const status = turnDecs[turnDecs.length - 1]?.conversation_status ?? null;
      const w0 = w;
      const isPost = POST.test(status ?? "") || (applyAt && ms(applyAt) <= ms(end));
      for (const c of turnCalls.filter((x) => ms(x.ts!) < ms(end) - 1000)) {
        const nx = ms_.slice(i, j + 1).find((m) => ms(m.created_at) > ms(c.ts!) + 500);
        if (nx) (isPost ? postMidGaps : midGaps).push({ fromMsg: (ms(nx.created_at) - ms(c.ts!)) / 1000, fromCall: (ms(nx.created_at) - ms(c.l.created_at)) / 1000, fromStart: (ms(nx.created_at) - (ms(c.l.created_at) - (c.l.duration_ms ?? 0))) / 1000, scene: resolveReplyScene({ customerText: ms_.slice(i, j + 1).map((m) => m.text ?? "").join("\n") }).scene, route: c.l.route ?? "" });
      }
      if (isPost) { skipped.post++; skipped.postMid += turnCalls.filter((c) => ms(c.ts!) < ms(end) - 1000).length; skipped.postAfterStaff += turnCalls.filter((c) => w0.staffFirstAt && ms(c.l.created_at) > ms(w0.staffFirstAt)).length; skipped.postCalls += turnCalls.length; skipped.postUsd += turnCalls.reduce((a, c) => a + callUsd(c.l), 0); continue; }
      const firstStaff = w.staffFirstAt;
      const callsMid = turnCalls.filter((c) => ms(c.ts!) < ms(end) - 1000).length;
      // 番の中の最後の発言を見た呼び出しが2回以上（返事の前）: 2回目以降の間隔と経路
      const lastSeen = turnCalls.filter((c) => ms(c.ts!) >= ms(end) - 1000 && (!w.staffFirstAt || ms(c.l.created_at) < ms(w.staffFirstAt)));
      for (let k = 1; k < lastSeen.length; k++) dupPre.push({ gapSec: (ms(lastSeen[k].l.created_at) - ms(lastSeen[k - 1].l.created_at)) / 1000, route: `${lastSeen[k - 1].l.route}→${lastSeen[k].l.route}`, img: /\[画像\]/.test(ms_.slice(i, j + 1).map((m) => m.text ?? "").join("")) });
      const callsPost = turnCalls.filter((c) => firstStaff && ms(c.l.created_at) > ms(firstStaff)).length;
      const callsPre = turnCalls.length - callsPost;
      const usd = turnCalls.reduce((a, c) => a + callUsd(c.l), 0);
      const text = ms_.slice(i, j + 1).map((m) => m.text ?? "").join("\n");
      const scene = resolveReplyScene({ customerText: text }).scene;
      const t = text.normalize("NFKC").trim();
      const scope = resolveAckTopicScope(ms_.slice(Math.max(0, i - 30), j + 1).map((m) => ({ sender: m.sender, text: m.text, created_at: m.created_at, is_aix_generated: m.is_aix_generated })));
      const cls = /^(?:\[スタンプ\]\s*)+$/.test(t) ? "stamp_only"
        : isAckOnlyTurn(text) ? (scope.applies && scope.closedNonPropertyTopic ? "ack_closed" : scope.applies && scope.topicOpen ? "ack_after_promise" : "ack_other")
        : scene === "ack" ? "ack_scene_other" : "substance";
      const bp = [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))];
      const bt = w.texts.filter((x) => x.burst).map((x) => x.text).join("\n");
      const staffPath = bp.length ? bp : bt ? ["reply"] : [];
      const preDecs = turnDecs.filter((d) => ms(d.analyzed_msg_ts!) >= ms(end) - 1000 && (!firstStaff || ms(d.created_at) < ms(firstStaff)));
      const last = preDecs[preDecs.length - 1] ?? null;
      // 同じ最後の発言を1時間以上あけて見直した番（返事の前）: 最初の判断と最後の判断の道の一致
      if (last && preDecs.length >= 2 && ms(last.created_at) - ms(preDecs[0].created_at) > 3600_000 && staffPath.length && w.closed) {
        const f0 = preDecs[0];
        const k = (d: D) => (d.suggested_reply_mode === "aix" ? d.suggested_action : "reply");
        relook.push({ okFirst: pathOk({ action: f0.suggested_action, mode: f0.suggested_reply_mode, src: f0.decision_source }, staffPath), okLast: pathOk({ action: last.suggested_action, mode: last.suggested_reply_mode, src: last.decision_source }, staffPath), same: k(f0) === k(last), hours: (ms(last.created_at) - ms(f0.created_at)) / 3600_000 });
      }
      const prevD = [...ds].reverse().find((d) => ms(d.created_at) < ms(start)) ?? null;
      const toDec = (d: D | null): Dec => (d ? { action: d.suggested_action, mode: d.suggested_reply_mode, src: d.decision_source } : null);
      const row: Row = { conv, at: end, scene, cls, text: text.slice(0, 120), calls: turnCalls.length, callsPre, callsPost, callsMid, usd, staff: staffPath, brain: toDec(last), prev: toDec(prevD), okBrain: false, okPrev: false, okReply: false, llmSrc: isLlmSrc(last?.decision_source ?? null) };
      if (!w.closed) skipped.open++;
      if (staffPath.length && last && w.closed) {
        row.okBrain = pathOk(row.brain, staffPath); row.okPrev = pathOk(row.prev, staffPath); row.okReply = pathOk(null, staffPath);
      } else if (!staffPath.length) skipped.noStaff++; else if (!last) skipped.noDec++;
      rows.push(row);
    }
  }
  const scored = (rs: Row[]) => rs.filter((r) => r.staff.length && r.brain);
  const calls = rows.reduce((a, r) => a + r.calls, 0), usdAll = rows.reduce((a, r) => a + r.usd, 0);
  console.log(`\n■① 回数（お客様の番 ${rows.length}・brain_fresh ${calls}回 $${usdAll.toFixed(2)}・除外: 申込以降 ${skipped.post}番（${skipped.postCalls}回 $${skipped.postUsd.toFixed(2)}・うち連投の途中 ${skipped.postMid}・スタッフの返事の後 ${skipped.postAfterStaff}）・スタッフ返事なし ${skipped.noStaff}・スタッフ前の判断なし ${skipped.noDec}）`);
  const mid = rows.reduce((a, r) => a + r.callsMid, 0), post = rows.reduce((a, r) => a + r.callsPost, 0);
  console.log(`  連投の途中（番の最後の発言より前の発言を見た呼び出し）: ${mid}回（${Math.round((mid / calls) * 100)}%）｜スタッフの最初の返事の後の呼び出し: ${post}回（${Math.round((post / calls) * 100)}%）｜同じ番で2回以上（返事の前）: ${rows.filter((r) => r.callsPre >= 2).length}番`);
  {
    const fm = midGaps.map((g) => g.fromMsg).sort((a, b) => a - b);
    const within = (s: number) => fm.filter((x) => x <= s).length;
    console.log(`  連投の途中 ${midGaps.length}回: 見た発言から次の発言まで（秒）p25 ${fm[Math.floor(fm.length * 0.25)]?.toFixed(0)}・p50 ${fm[Math.floor(fm.length * 0.5)]?.toFixed(0)}・p75 ${fm[Math.floor(fm.length * 0.75)]?.toFixed(0)}｜≤20秒 ${within(20)}・≤30秒 ${within(30)}・≤45秒 ${within(45)}・≤60秒 ${within(60)}・≤90秒 ${within(90)}・≤120秒 ${within(120)}`);
    console.log(`    呼び出しの記録（応答の時刻）より前に次の発言が来ていた: ${midGaps.filter((g) => g.fromCall <= 0).length}回・LLM に送る前（記録の時刻−所要時間）に来ていた: ${midGaps.filter((g) => g.fromStart <= 0).length}回`);
    const sa = midGaps.map((g) => g.fromStart).sort((a, b) => a - b);
    const sp = postMidGaps.map((g) => g.fromStart).sort((a, b) => a - b);
    console.log(`    （申込以降の番 ${sp.length}回）LLM に送った時刻から次の発言まで（秒）: ≤0 ${sp.filter((x) => x <= 0).length}・≤10 ${sp.filter((x) => x <= 10).length}・≤20 ${sp.filter((x) => x <= 20).length}・≤30 ${sp.filter((x) => x <= 30).length}・≤60 ${sp.filter((x) => x <= 60).length}`);
    console.log(`    LLM に送った時刻から次の発言まで（秒）: ≤0 ${sa.filter((x) => x <= 0).length}・≤10 ${sa.filter((x) => x <= 10).length}・≤20 ${sa.filter((x) => x <= 20).length}・≤30 ${sa.filter((x) => x <= 30).length}・≤60 ${sa.filter((x) => x <= 60).length}`);
    const bySc = new Map<string, number>(); for (const g of midGaps) bySc.set(g.scene, (bySc.get(g.scene) ?? 0) + 1);
    const byRt = new Map<string, number>(); for (const g of midGaps) byRt.set(g.route, (byRt.get(g.route) ?? 0) + 1);
    console.log(`    場面: ${[...bySc].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}｜経路: ${[...byRt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
    const dg = dupPre.map((d) => d.gapSec).sort((a, b) => a - b);
    const byR = new Map<string, number>(); for (const d of dupPre) byR.set(d.route, (byR.get(d.route) ?? 0) + 1);
    console.log(`  同じ最後の発言を返事の前に2回以上見た呼び出し ${dupPre.length}回（画像あり ${dupPre.filter((d) => d.img).length}）: 間隔（秒）p25 ${dg[Math.floor(dg.length * 0.25)]?.toFixed(0)}・p50 ${dg[Math.floor(dg.length * 0.5)]?.toFixed(0)}・p75 ${dg[Math.floor(dg.length * 0.75)]?.toFixed(0)}｜経路 ${[...byR].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  console.log(`  同じ最後の発言を1時間以上あけて見直した番（返事の前・判定できた）${relook.length}: 道が同じ ${relook.filter((r) => r.same).length}｜最初の判断の一致 ${ci(relook.filter((r) => r.okFirst).length, relook.length)}・見直した判断の一致 ${ci(relook.filter((r) => r.okLast).length, relook.length)}（下がる ${relook.filter((r) => r.okFirst && !r.okLast).length}・上がる ${relook.filter((r) => !r.okFirst && r.okLast).length}）`);
  console.log("  型 | 番 | 呼び出し（返事の前/後/途中）| $ | 判定できた番 | ブレイン（今）の道の一致 | 前の番の判断を使い回す | いつも返信 | LLM が決めた割合");
  const classes = ["stamp_only", "ack_closed", "ack_other", "ack_after_promise", "ack_scene_other", "substance"];
  for (const c of [...classes, "全体"]) {
    const rs = rows.filter((r) => c === "全体" || r.cls === c);
    const sc = scored(rs);
    const k = (f: (r: Row) => boolean) => sc.filter(f).length;
    console.log(`  ${c.padEnd(18)} | ${rs.length} | ${rs.reduce((a, r) => a + r.calls, 0)}（${rs.reduce((a, r) => a + r.callsPre, 0)}/${rs.reduce((a, r) => a + r.callsPost, 0)}/${rs.reduce((a, r) => a + r.callsMid, 0)}）| ${rs.reduce((a, r) => a + r.usd, 0).toFixed(2)} | ${sc.length} | ${ci(k((r) => r.okBrain), sc.length)} | ${ci(k((r) => r.okPrev), sc.length)} | ${ci(k((r) => r.okReply), sc.length)} | ${ci(rs.filter((r) => r.brain && r.llmSrc).length, rs.filter((r) => r.brain).length)}`);
  }
  // 対にした差（使い回し − 今）を番ごとに: 一致が下がる番（今は合い・使い回しは外れ）と上がる番
  for (const c of ["stamp_only", "ack_closed", "ack_other", "ack_after_promise"]) {
    const sc = scored(rows.filter((r) => r.cls === c));
    const down = sc.filter((r) => r.okBrain && !r.okPrev).length, up = sc.filter((r) => !r.okBrain && r.okPrev).length;
    const downR = sc.filter((r) => r.okBrain && !r.okReply).length, upR = sc.filter((r) => !r.okBrain && r.okReply).length;
    console.log(`  ${c}: 使い回しで 下がる番 ${down}・上がる番 ${up}｜いつも返信で 下がる番 ${downR}・上がる番 ${upR}`);
    for (const r of sc.filter((x) => x.okBrain && !x.okReply).slice(0, 6)) console.log(`     ↓ ${r.conv.slice(0, 8)} ${r.at.slice(5, 16)} 客「${r.text.replace(/\n/g, "⏎").slice(0, 40)}」 ブレイン=${r.brain?.mode === "aix" ? r.brain.action : "返信"}(${r.brain?.src ?? "-"}) 人=${r.staff.join(",")}`);
  }
  console.log("\n■② 場面ごと（判定できた番）: 場面 | 番 | 呼び出し | $ | ブレインの道の一致 | LLM が決めた番 | その番の一致 | 決定論の番 | その番の一致");
  for (const s of ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply", "other", "全体"]) {
    const rs = rows.filter((r) => s === "全体" || r.scene === s);
    const sc = scored(rs);
    const L_ = sc.filter((r) => r.llmSrc), Dt = sc.filter((r) => !r.llmSrc);
    console.log(`  ${s.padEnd(15)} | ${rs.length} | ${rs.reduce((a, r) => a + r.calls, 0)} | ${rs.reduce((a, r) => a + r.usd, 0).toFixed(2)} | ${ci(sc.filter((r) => r.okBrain).length, sc.length)}（n=${sc.length}）| ${L_.length} | ${ci(L_.filter((r) => r.okBrain).length, L_.length)} | ${Dt.length} | ${ci(Dt.filter((r) => r.okBrain).length, Dt.length)}`);
  }
  if (OUT) writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
