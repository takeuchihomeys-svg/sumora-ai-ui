/**
 * 1人のお客さん→次のお客さんの切替を「直した後のきまり」で再生して見積もる（読むだけ・DB に書かない・費用0）。
 *
 * 2026-11-18 竹内さん「直した後の動きは想定して計算できないのか」:
 *   実際の録画（search_audits の段・human_motion_learn の操作）を、旧のきまりと新のきまり（2.8.106）の両方で再生する。
 *   旧のきまりで実測どおりの結果が出る（＝再生が正しい）ことを先に確かめてから、新のきまりの結果を出す。
 *   時間は同じお客さんの過去の回（区1つの間・検索まで・送付まで）の中央値で見積もる。
 *
 * 使い方:
 *   npx tsx --env-file=.env.local scripts/sim-customer-handoff.ts --audit=1488 --next=1489
 */
import { createRequire } from "node:module";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const req = createRequire(__filename);
const H = req(path.join(__dirname, "..", "chrome-extension", "customer-handoff.js")) as {
  gateHoldsBatch: (k: unknown) => boolean;
  tabHandoffDecision: (p: unknown, cid: string, waited: number) => string;
  pendingFlagBlockReason: (flag: unknown, busy: unknown, nowCid: string | null, now: number) => string | null;
};

const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || "";
const AUDIT = Number(arg("audit") || 1488);
const NEXT = Number(arg("next") || 0);

type Step = { k?: string; d?: unknown; at?: number };
type Audit = {
  id: number; created_at: string; finished_at: string | null; status: string; error: string | null;
  property_customer_id: string | null; site: string | null; trigger: string | null; steps: Step[] | null; ext_version: string | null;
};
type Op = Record<string, unknown>;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const hm = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(11, 19);
const med = (xs: number[]) => { const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const sec = (ms: number) => (Number.isFinite(ms) ? Math.round(ms / 1000) + "秒" : "不明");
const stepsOf = (a: Audit) => (Array.isArray(a.steps) ? a.steps : []).filter((s) => typeof s.at === "number").sort((x, y) => (x.at as number) - (y.at as number));
const has = (s: Step, re: RegExp) => re.test(String(s.k || ""));

void (async () => {
  const cols = "id,created_at,finished_at,status,error,property_customer_id,site,trigger,steps,ext_version";
  const { data: a0 } = await sb.from("search_audits").select(cols).eq("id", AUDIT).maybeSingle();
  if (!a0) { console.log("audit が読めない", AUDIT); return; }
  const cur = a0 as unknown as Audit;
  const cid = String(cur.property_customer_id || "");
  const nextA = NEXT ? ((await sb.from("search_audits").select(cols).eq("id", NEXT).maybeSingle()).data as unknown as Audit | null) : null;

  // ── 同じお客さんの過去の回（見積もりの材料） ──
  const { data: hist } = await sb.from("search_audits").select(cols)
    .eq("property_customer_id", cid).lt("id", AUDIT).order("id", { ascending: false }).limit(15);
  const perWard: number[] = [], wardToSearch: number[] = [], fillTotal: number[] = [], sendTotal: number[] = [];
  let histN = 0;
  for (const h of (hist || []) as unknown as Audit[]) {
    const st = stepsOf(h);
    const wards = st.filter((s) => has(s, /ward_by_code|ward_scroll_select/)).map((s) => s.at as number);
    for (let i = 1; i < wards.length; i++) { const g = wards[i] - wards[i - 1]; if (g > 300 && g < 120000) perWard.push(g); }
    const search = st.find((s) => has(s, /search_armed|click_search|clickSearch|fill_done/));
    const t0 = Date.parse(h.created_at);
    if (search && wards.length) wardToSearch.push((search.at as number) - wards[wards.length - 1]);
    if (search) fillTotal.push((search.at as number) - t0);
    if (search && h.finished_at && /auto_pdf|batch|sent/.test(JSON.stringify(st.slice(-20)))) sendTotal.push(Date.parse(h.finished_at) - (search.at as number));
    histN++;
  }
  const W = med(perWard), WS = med(wardToSearch), SEND = med(sendTotal);

  // ── この回の事実 ──
  const st = stepsOf(cur);
  const t0 = Date.parse(cur.created_at);
  const fillStart = st.find((s) => has(s, /fill_start/))?.at ?? t0;
  const wardFix = st.find((s) => has(s, /ward_fix/));
  const wantWards = (() => { const m = String(wardFix?.d || "").match(/(\d+)件/); return m ? Number(m[1]) : NaN; })();
  const doneWards = (() => { const xs = st.filter((s) => has(s, /ward_by_code/)).map((s) => String(s.d || "").match(/済(\d+)\//)).filter(Boolean).map((m) => Number((m as RegExpMatchArray)[1])); return xs.length ? Math.max(...xs) : 0; })();
  const stopStep = st.find((s) => has(s, /human_takeover/)) || st.find((s) => has(s, /fill_done/));
  const stopAt = (stopStep?.at as number) || (cur.finished_at ? Date.parse(cur.finished_at) : t0);

  // 録画の操作（この回の前後3分）
  const winFrom = new Date(t0 - 60e3).toISOString(), winTo = new Date(stopAt + 180e3).toISOString();
  const { data: mots } = await sb.from("human_motion_learn").select("created_at,mode,shot_ops")
    .eq("site", "realpro").gte("created_at", winFrom).lte("created_at", new Date(stopAt + 600e3).toISOString())
    .order("created_at", { ascending: true }).limit(20);
  const seen = new Set<string>();
  const ops: Array<{ at: number; who: string; type: string; label: string }> = [];
  for (const m of (mots || []) as Array<{ shot_ops: Op[] | null }>) {
    for (const o of Array.isArray(m.shot_ops) ? m.shot_ops : []) {
      const at = Number(o.t ?? o.at ?? 0); if (!at) continue;
      if (at < Date.parse(winFrom) || at > Date.parse(winTo)) continue;
      const type = String(o.k ?? o.type ?? ""); if (type !== "click" && type !== "change" && type !== "input" && type !== "key") continue;
      const label = String(o.f ?? o.name ?? o.label ?? "");
      const who = String(o.by ?? o.who ?? o.src ?? (o.auto ? "auto" : o.human ? "human" : ""));
      const key = at + "|" + type + "|" + label; if (seen.has(key)) continue; seen.add(key);
      ops.push({ at, who, type, label });
    }
  }
  ops.sort((a, b) => a.at - b.at);
  const humanOps = ops.filter((o) => /human/.test(o.who));
  const autoOps = ops.filter((o) => /auto/.test(o.who));

  console.log(`■ 再生する回: audit ${cur.id}（${cur.trigger}・版 ${cur.ext_version || "?"}）客=${cid.slice(0, 8)}`);
  console.log(`  入力開始 ${hm(fillStart)} ／ 止まった ${hm(stopAt)} ／ 止まった理由: ${String(cur.error || "").slice(0, 70)}`);
  console.log(`  区: 欲しい ${wantWards}・押せた ${doneWards} ／ 録画の操作 ${ops.length}（自動 ${autoOps.length}・人 ${humanOps.length}）`);
  if (ops[0]) console.log(`  操作の形（先頭）: ${JSON.stringify(ops[0])}`);
  console.log(`■ 見積もりの材料: 同じお客さんの過去 ${histN} 回 → 区1つの間 ${sec(W)}（n=${perWard.length}）・最後の区→検索 ${sec(WS)}（n=${wardToSearch.length}）・検索→送付完了 ${sec(SEND)}（n=${sendTotal.length}）`);

  // ── 旧のきまり（2.8.103〜105）で再生 → 実測と合うか ──
  console.log("\n■ 旧のきまりで再生（実測と合えば再生は正しい）");
  const firstAutoAfter = autoOps.find((o) => o.at > fillStart + 1500 && /city_code|one_city|区/.test(o.label));
  const oldStop = firstAutoAfter ? firstAutoAfter.at : NaN;
  console.log(`  自動のクリック（${firstAutoAfter?.label.slice(0, 20) || "?"}）→ ブラウザが change（isTrusted=true）を出す → 旧は change を人と数える → ${hm(oldStop)} に止まる`);
  console.log(`  実測: ${hm(stopAt)} に human_takeover ／ 再生との差 ${sec(Math.abs(stopAt - oldStop))} → ${Math.abs(stopAt - oldStop) < 3000 ? "合う ✓" : "合わない ✗"}`);
  console.log(`  旧: 関所の止まりは「飛ばして次へ」→ 次のお客さん開始（実測 ${nextA ? hm(Date.parse(nextA.created_at)) : "?"}・止まってから ${nextA ? sec(Date.parse(nextA.created_at) - stopAt) : "?"}）`);

  // ── 新のきまり（2.8.106）で再生 ──
  console.log("\n■ 新のきまり（2.8.106）で再生");
  const autoFalseStops = autoOps.filter((o) => o.at > fillStart + 1500).length;
  console.log(`  ① 自動の操作 ${autoOps.length} 件: スクリプトの click() は pointerdown を出さない → 人の判定に入るのは 0 件（誤停止 0）`);
  void autoFalseStops;
  const remain = Number.isFinite(wantWards) ? Math.max(0, wantWards - doneWards) : NaN;
  const lastWardAt = (st.filter((s) => has(s, /ward_by_code/)).pop()?.at as number) || stopAt;
  const tAllWards = lastWardAt + remain * W;
  const tSearch = tAllWards + WS;
  const tSendDone = tSearch + SEND;
  console.log(`  ② 区は止まらず続く: 残り ${remain} 区 × ${sec(W)} → 全区 ${hm(tAllWards)} 頃 → 検索 ${hm(tSearch)} 頃（入力 約${sec(tSearch - fillStart)}）`);
  const humanDuring = humanOps.filter((o) => o.at > fillStart + 1500 && o.at < tSearch);
  if (humanDuring.length) {
    const h0 = humanDuring[0];
    console.log(`  ③ 録画では ${hm(h0.at)} に人が「${h0.label.slice(0, 24)}」を押している（実際は自動が止まった後の操作）`);
    console.log(`     → もし入力中に人が押したら: pointerdown（本物）で止まる → gateKind=human_takeover → 一括を止める=${H.gateHoldsBatch("human_takeover")}（次のお客さんへ進まない）`);
  } else {
    console.log("  ③ 入力中に人の操作なし → 止まらない");
  }
  console.log(`  ④ 検索の後は送付の完了（batch-customer-done）まで待つ → 送付完了 ${hm(tSendDone)} 頃`);
  if (nextA) {
    const nextCid = String(nextA.property_customer_id || "");
    const probeDuring = { fillRunning: true, fillCustomerId: cid };
    const probeAfter = { fillRunning: false, fillCustomerId: null };
    console.log(`  ⑤ 次のお客さん（${nextCid.slice(0, 8)}）: 入力中にタブを見たら → ${H.tabHandoffDecision(probeDuring, nextCid, 0)}（待つ）／入力が終わった後 → ${H.tabHandoffDecision(probeAfter, nextCid, 0)}`);
    const tNext = tSendDone;
    console.log(`     次のお客さんの開始 ${hm(tNext)} 頃（旧より ${sec(tNext - Date.parse(nextA.created_at))} 後）。開始で前の検索の印を消し、入力開始の印（busy.at=${hm(tNext)}）を置く`);
    const oldFlag = { ts: tSearch, customerId: cid };
    const why = H.pendingFlagBlockReason(oldFlag, { at: tNext, customerId: nextCid }, nextCid, tNext + 21000);
    console.log(`  ⑥ 実測で押された 08:02:30 型（次のお客さんの入力前の読み直し）: 前のお客さんの印が残っていても → ${why ? "押さない（" + why + "）" : "押す ✗"}`);
    const goodFlag = { ts: tNext + 120000, customerId: nextCid };
    const ok = H.pendingFlagBlockReason(goodFlag, { at: tNext, customerId: nextCid }, nextCid, tNext + 125000);
    console.log(`     次のお客さんが検索した後の正しい読み直し → ${ok ? "押さない ✗（" + ok + "）" : "押す ✓"}`);
  }

  console.log("\n■ 計算で言えないこと");
  console.log("  ・リアプロの画面が残りの区を本当に出すか（区の並び・スクロール）は再生では分からない（過去の回の間で見積もっただけ）");
  console.log("  ・送付の時間は一覧の件数で大きく変わる（中央値）");
  console.log("  ・人がいつ触るかは予測できない（触れば止まり、一括も止まる）");
})();
