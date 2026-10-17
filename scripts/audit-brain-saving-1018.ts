// scripts/audit-brain-saving-1018.ts — ブレインの「質を落とさない節約」3つを本番の記録で数える（読むだけ・LLM なし）
//   1. sweep の申込以降の漏れ: route=/api/cron/brain-sweep の brain_fresh/brain_full を、その時点の記録で resolvePostApply し直す
//      （申込以降と出た物は post-apply-brain-gate で「否決・取り消し・クレーム等の番か」も判定する＝直した後も回る番）
//   2. 本当の二重: 同じ会話・同じ入力の鍵（最後のお客様の発言の時刻＋最後のスタッフ/AIX の送信の時刻）で続けて回ったブレイン（brain_fresh/brain_full）
//   出す数は直す前の実物。直した後の見積もりは「この関門で止まる番」の数と費用。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-saving-1018.ts [--days=14] [--show=1|2|all]
import { createClient } from "@supabase/supabase-js";
import { claudeUsageUsd } from "../app/lib/llm-price";
import { resolvePostApply } from "../app/lib/post-apply";
import { decidePostApplyBrainGate, POST_APPLY_GATE_STATUSES, postApplyAnchorAt, type GateMsg } from "../app/lib/post-apply-brain-gate";
import { brainInputKeyOf, decideInputKeyReuse } from "../app/lib/brain-input-key";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "14"));
const SHOW = arg("show");
const SINCE = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; await sleep(200); }
  return out;
}
type L = { created_at: string; conversation_id: string | null; route: string | null; action: string; model: string | null; input_uncached: number; cache_read: number; cache_write_5m: number; cache_write_1h: number; cache_write: number; output_tokens: number; duration_ms: number | null };
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_type: string | null };
type P = { conversation_id: string; created_at: string; aix_type: string | null };
type C = { id: string; status: string | null; is_post_apply: boolean | null; status_manual_back_at: string | null; deepseek_cutoff_at: string | null };
type D = { conversation_id: string; created_at: string; conversation_status: string | null };
const t = (s: string) => Date.parse(s);
const short = (r: string | null) => (r ?? "").replace("/api/", "").replace("cron/", "c:").replace("generate-draft-bg-async", "bg").replace("generate-pending-drafts", "pend").replace("send-line-message", "send").replace("line-webhook", "hook").replace("brain-sweep", "sweep");

(async () => {
  const llm = (await readAll<L>((f, to) => sb.from("llm_usage_logs").select("created_at, conversation_id, route, action, model, input_uncached, cache_read, cache_write_5m, cache_write_1h, cache_write, output_tokens, duration_ms")
    .gte("created_at", SINCE).eq("env", "production").in("action", ["brain_fresh", "brain_full", "brain_fresh_claude"]).lt("status", 400).order("created_at").range(f, to))).filter((r) => r.conversation_id);
  const convIds = [...new Set(llm.map((r) => r.conversation_id as string))];
  const msgs: M[] = [], pushes: P[] = [], convs: C[] = [], decs: D[] = [];
  for (let i = 0; i < convIds.length; i += 50) {
    const ids = convIds.slice(i, i + 50);
    msgs.push(...await readAll<M>((f, to) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, image_type").in("conversation_id", ids).gte("created_at", new Date(t(SINCE) - 60 * 86_400_000).toISOString()).order("created_at").order("id").range(f, to)));
    pushes.push(...await readAll<P>((f, to) => sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type").in("conversation_id", ids).not("aix_type", "is", null).order("created_at").range(f, to)));
    convs.push(...await readAll<C>((f, to) => sb.from("conversations").select("id, status, is_post_apply, status_manual_back_at, deepseek_cutoff_at").in("id", ids).range(f, to)));
    decs.push(...await readAll<D>((f, to) => sb.from("brain_decision_logs").select("conversation_id, created_at, conversation_status").in("conversation_id", ids).gte("created_at", SINCE).order("created_at").range(f, to)));
  }
  const group = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = group(msgs), pBy = group(pushes), dBy = group(decs);
  const cBy = new Map(convs.map((c) => [c.id, c]));
  const usd = (r: L) => claudeUsageUsd(r as never);
  const startOf = (r: L) => t(r.created_at) - Math.max(0, Number(r.duration_ms) || 0);

  // ── 1. sweep の申込以降 ─────────────────────────────────────────
  const sweep = llm; // 全経路を判定し、sweep の数は isSweep で分ける
  const otherStop: Record<string, { n: number; usd: number; inGate: number }> = {};
  const tally = { total: 0, totalUsd: 0, post: 0, postUsd: 0, gateRun: 0, gateRunUsd: 0, gateStop: 0, gateStopUsd: 0, movedBack: 0, inGate: 0, inGateStop: 0, inGateStopUsd: 0, byReason: {} as Record<string, number>, statuses: {} as Record<string, number>, convs: new Set<string>() };
  const show1: string[] = [];
  for (const r of sweep) {
    const cid = r.conversation_id as string, s = startOf(r), c = cBy.get(cid);
    const isSweep = r.route === "/api/cron/brain-sweep";
    if (isSweep) { tally.total++; tally.totalUsd += usd(r); }
    const ms_ = (mBy.get(cid) ?? []).filter((m) => t(m.created_at) <= s);
    const lastBefore = (xs: string[]) => xs.filter((x) => t(x) <= s).at(-1) ?? null;
    const pushAt = lastBefore((pBy.get(cid) ?? []).filter((p) => p.aix_type === "application_push").map((p) => p.created_at));
    const docAt = lastBefore(ms_.filter((m) => m.sender === "customer" && (m.image_type === "id_document" || m.image_type === "income_document")).map((m) => m.created_at));
    // その時の status: 分析の後に書く判断の記録（±5分）のを優先・無ければ今の値
    const dec = (dBy.get(cid) ?? []).find((d) => Math.abs(t(d.created_at) - t(r.created_at)) < 5 * 60_000);
    const status = dec?.conversation_status ?? c?.status ?? null;
    const okAt = (x: string | null | undefined) => (x && t(x) <= s ? x : null);
    const pa = resolvePostApply({ status, isPostApply: c?.is_post_apply ?? false, applicationPushAt: pushAt, idDocumentAt: docAt, statusManualBackAt: okAt(c?.status_manual_back_at), deepseekCutoffAt: okAt(c?.deepseek_cutoff_at) });
    if (pa.movedBack && isSweep) tally.movedBack++;
    if (!pa.postApply) continue;
    if (!isSweep) {
      const inG = POST_APPLY_GATE_STATUSES.has((status ?? "").trim());
      const anc = inG ? pushAt : postApplyAnchorAt(pushAt, docAt);
      const g2 = decidePostApplyBrainGate({ status: inG ? status : "proposing", lagging: !inG, presses: (pBy.get(cid) ?? []).filter((p) => t(p.created_at) <= s), msgs: ms_.filter((m) => !anc || t(m.created_at) >= t(anc)).slice(-300), applicationPushAt: anc, idDocumentAt: docAt, env: {} });
      if (!g2.run) { const k = short(r.route) + " " + r.action; otherStop[k] = otherStop[k] ?? { n: 0, usd: 0, inGate: 0 }; otherStop[k].n++; otherStop[k].usd += usd(r); if (inG) otherStop[k].inGate++; }
      continue;
    }
    tally.post++; tally.postUsd += usd(r); tally.convs.add(cid);
    tally.statuses[status ?? "null"] = (tally.statuses[status ?? "null"] ?? 0) + 1;
    const inGate = POST_APPLY_GATE_STATUSES.has((status ?? "").trim());
    // 本体と同じ起点（申込中は申込へ押下・遅れは最後の申込の記録）
    const anchor = inGate ? pushAt : postApplyAnchorAt(pushAt, docAt);
    const gm: GateMsg[] = ms_.filter((m) => !anchor || t(m.created_at) >= t(anchor)).slice(-300).map((m) => ({ sender: m.sender, text: m.text, created_at: m.created_at }));
    const presses = (pBy.get(cid) ?? []).filter((p) => t(p.created_at) <= s);
    const g = decidePostApplyBrainGate({ status: inGate ? status : "proposing", lagging: !inGate, presses, msgs: gm, applicationPushAt: anchor, idDocumentAt: docAt, env: {} });
    if (inGate) { tally.inGate++; if (!g.run) { tally.inGateStop++; tally.inGateStopUsd += usd(r); } }
    const key = g.run ? g.reason.replace(/:.*/, "") : "stop";
    tally.byReason[key] = (tally.byReason[key] ?? 0) + 1;
    if (g.run) { tally.gateRun++; tally.gateRunUsd += usd(r); } else { tally.gateStop++; tally.gateStopUsd += usd(r); }
    if (SHOW === "1" || SHOW === "all") show1.push(`  ${r.created_at.slice(5, 16)} ${cid.slice(0, 8)} ${r.action} st=${status} why=${pa.reason} ${inGate ? "" : "遅れ "}gate=${g.run ? "回す" : "止める"}:${g.reason} $${usd(r).toFixed(3)} 最後の番「${(ms_.filter((m) => m.sender === "customer").at(-1)?.text ?? "").slice(0, 30).replace(/\n/g, " ")}」`);
  }
  console.log(`\n=== 1. sweep の申込以降（${DAYS}日・本番） ===`);
  console.log(`sweep のブレイン ${tally.total}回 $${tally.totalUsd.toFixed(2)} / うち申込以降（記録から） ${tally.post}回 $${tally.postUsd.toFixed(2)}（${tally.convs.size}会話） / 否決で戻した判定 ${tally.movedBack}回（申込前として扱う＝今まで通り回す）`);
  console.log(`  その時の status:`, tally.statuses);
  console.log(`  直した後も回る（否決・取り消し・クレーム等） ${tally.gateRun}回 $${tally.gateRunUsd.toFixed(2)} / 止まる ${tally.gateStop}回 $${tally.gateStopUsd.toFixed(2)}（週 $${(tally.gateStopUsd / DAYS * 7).toFixed(2)}）`);
  console.log(`  理由の内訳:`, tally.byReason);
  console.log(`  うち status が申込中・審査中（10/07 からブレイン本体の関所が止める側） ${tally.inGate}回（止まる ${tally.inGateStop}回 $${tally.inGateStopUsd.toFixed(2)}）＝残りが status の遅れの漏れ（直して止まる ${tally.gateStop - tally.inGateStop}回 $${(tally.gateStopUsd - tally.inGateStopUsd).toFixed(2)}・週 $${((tally.gateStopUsd - tally.inGateStopUsd) / DAYS * 7).toFixed(2)}）`);
  console.log(`  （参考）sweep 以外の経路でブレイン本体の関所が止める番（inGate＝status が申込中・審査中＝10/07 から止まっている側）:`, otherStop);
  if (show1.length) console.log(show1.join("\n"));

  // ── 2. 同じ入力の鍵の二重（毎回の分析 brain_fresh 同士。brain_full＝戦略のゼロからの作り直しは毎回の分析の後に続く仕様なので数えない）──
  const byConv = new Map<string, L[]>();
  for (const r of llm) { const k = r.conversation_id as string; if (!byConv.has(k)) byConv.set(k, []); byConv.get(k)!.push(r); }
  let total = 0, totalUsd = 0, dup = 0, dupUsd = 0, stop = 0, stopUsd = 0, overlapFull = 0, overlapFullUsd = 0;
  const kinds: Record<string, { n: number; usd: number; stop: number }> = {};
  const show2: string[] = [];
  for (const [cid, rows] of byConv) {
    const ms_ = mBy.get(cid) ?? [];
    const presses = pBy.get(cid) ?? [];
    let prev: { key: string; r: L } | null = null;
    for (const r of rows) {
      total++; totalUsd += usd(r);
      const s = startOf(r);
      const before = ms_.filter((m) => t(m.created_at) <= s);
      const lastPress = presses.filter((p) => t(p.created_at) <= s).at(-1)?.created_at ?? null;
      const key = brainInputKeyOf(before, lastPress);
      if (r.action !== "brain_fresh") {
        // 戦略のゼロからの作り直しが、同じ鍵の毎回の分析が走っている間に始まった（重なり）
        if (prev && prev.key === key && s < t(prev.r.created_at)) { overlapFull++; overlapFullUsd += usd(r); }
        continue;
      }
      if (prev && prev.key === key) {
        dup++; dupUsd += usd(r);
        const gap = s - t(prev.r.created_at); // 前の終わり→今の始まり（負＝重なり）
        const pr = short(prev.r.route), nr = short(r.route);
        const lastOut = before.filter((m) => m.sender !== "customer").at(-1);
        const imageTurn = before.some((m) => m.sender === "customer" && (!lastOut || t(m.created_at) > t(lastOut.created_at)) && /^\s*\[(?:画像|ファイル)\]/.test(m.text ?? ""));
        const kind = gap < 0 ? `③重なり（${pr}→${nr}）`
          : nr === "c:sweep" && gap >= 10 * 60_000 ? `②sweep が後で拾い直し（前=${pr}）`
          : gap <= 60_000 ? `①60秒以内（${pr}→${nr}）` : `その他 ${pr}→${nr}`;
        // 直した後に止まるか: 送信の後（forced）・画像の番（読み取りの前後で中身が変わりうる＝forced で回る）は止めない。重なりは同時に走るので鍵の比べが効かない
        const d = decideInputKeyReuse({ key, prevKey: prev.key, prevSource: "brain_fresh", prevAnalyzedAt: prev.r.created_at, forced: nr === "send" || imageTurn, nowMs: s, env: {} });
        const stops = gap >= 0 && d.reuse;
        if (stops) { stop++; stopUsd += usd(r); }
        kinds[kind] = kinds[kind] ?? { n: 0, usd: 0, stop: 0 }; kinds[kind].n++; kinds[kind].usd += usd(r); if (stops) kinds[kind].stop++;
        if (SHOW === "2" || SHOW === "all") show2.push(`  ${r.created_at.slice(5, 19)} ${cid.slice(0, 8)} ${pr} → ${nr} 間 ${Math.round(gap / 1000)}s ${imageTurn ? "画像の番 " : ""}${stops ? "止まる" : "回る:" + d.reason}`);
      }
      prev = { key, r };
    }
  }
  console.log(`\n=== 2. 同じ入力の鍵で続けて回った毎回の分析（${DAYS}日・本番・brain_fresh） ===`);
  console.log(`ブレイン全 ${total}回 $${totalUsd.toFixed(2)} / 毎回の分析の二重 ${dup}回 $${dupUsd.toFixed(2)}（${(dup / Math.max(1, total) * 100).toFixed(1)}%） / 直した後に止まる見積もり ${stop}回 $${stopUsd.toFixed(2)}（週 $${(stopUsd / DAYS * 7).toFixed(2)}）`);
  console.log(`  （参考）戦略のゼロからの作り直しが同じ鍵の分析と重なった ${overlapFull}回 $${overlapFullUsd.toFixed(2)}（6 の判断待ち・今回は触らない）`);
  for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k}: ${v.n}回 $${v.usd.toFixed(2)}（止まる ${v.stop}）`);
  if (show2.length) console.log(show2.join("\n"));
})();
