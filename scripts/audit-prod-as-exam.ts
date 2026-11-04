// scripts/audit-prod-as-exam.ts — 本番の記録を試験に使う（夜だけ・読むだけ・LLM なし・費用 0）
//
// 2026-11-04 竹内さん（KB P1「試験は使い回しまくる」）: 判断のブレインの過去の答え（brain_decision_logs の digest）と、スタッフが実際に送った物・押した AIX
//   （line_watch_turns の staff_aix・staff_texts・verdict）を突き合わせる。記録だけの物（統括メタ・入口の読み・need 等の欄）と判断の当たりは、試験を流さずにこれで確かめる。
//   数える物:
//     ① 判断の当たり: ブレインの道（brain_action の系統）がスタッフの一手（押した AIX の系統／返信だけ）と同じか（場面ごと）
//     ② 記録だけの欄が出ているか（digest の cm・ci・nd・tl・mp・fs・rl・rk・vw）＝本番で動いている事の確かめ
//     ③ 入口の読み（ci）: Sonnet の場面と、5番に1番の DeepSeek との合い方
//     ④ 記録だけの欄ごとに、その欄が出た番と出なかった番の当たりの差（記録だけなので差は出ないはず＝出たら混ざりを疑う）
//   上限: 窓 --days（既定 7・最大 30）・件数 --limit（既定 2000・最大 5000）。読みは2回（見張りの番1回＋digest を id でまとめて）。
//   営業時間（JST 9〜22時）は動かない（--force で手元の確かめだけ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-prod-as-exam.ts [--days=7] [--limit=2000] [--json]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { staffFirstMove, aixLogsFromWatch } from "../app/lib/staff-first-move";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }
const DAYS = Math.min(30, Math.max(1, Number(arg("days", "7"))));
const LIMIT = Math.min(5000, Math.max(100, Number(arg("limit", "2000"))));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

/** AIX の系統（同じ系統なら当たり） */
export function aixFamily(k: string | null | undefined): string {
  const s = String(k ?? "");
  if (!s) return "返信";
  if (/property_check|acknowledge_check/.test(s)) return "確認";
  if (/estimate|cost_/.test(s)) return "見積";
  if (/property_send|property_recommend|new_arrival/.test(s)) return "物件";
  if (/viewing|meeting/.test(s)) return "内覧";
  if (/application|apply/.test(s)) return "申込";
  if (/zenryoku|support/.test(s)) return "サポート";
  return s;
}
const RECORD_FIELDS = ["cm", "ci", "nd", "tl", "mp", "fs", "rl", "rk", "vw"] as const;

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  // 2026-11-04 作業員1（作業員2の気付き）: 本番の DB は1回の読みで1000行まで＝1000行ずつの頁で読む（.limit(LIMIT) の1回では 1000 で切れていた）
  const wt: unknown[] = [];
  for (let i = 0; wt.length < LIMIT; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, scene_key, brain_action, decision_id, staff_aix, verdict")
      .gte("customer_turn_at", since).not("decision_id", "is", null).order("customer_turn_at", { ascending: false }).range(i, Math.min(i + 999, LIMIT - 1));
    if (error) throw new Error(error.message);
    wt.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  type W = { id: number; conversation_id: string; customer_turn_at: string; scene_key: string | null; brain_action: string | null; decision_id: string; staff_aix: Array<{ aix_type: string; burst?: boolean; at?: string; check_pattern?: string | null }> | null; verdict: string | null };
  const turns = ((wt ?? []) as W[]).filter((w) => !isTestConversation(w.conversation_id) && w.verdict && w.verdict !== "na");
  const ids = turns.map((w) => w.decision_id);
  const dg = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("brain_decision_logs").select("id, digest").in("id", ids.slice(i, i + 200));
    for (const d of data ?? []) dg.set(d.id as string, (d.digest ?? {}) as Record<string, unknown>);
  }
  // 2026-11-04 竹内さんの決定（竹内さんのデータを優先）: 番ごとに、お客様の発言の後の最初のスタッフの送信の書き手（messages.staff_writer）を見る。竹内さんの番の当たりを主の数字にする
  const convs = [...new Set(turns.map((w) => w.conversation_id))];
  const staffMsgs = new Map<string, Array<{ at: number; writer: string | null; isAix: boolean }>>();
  for (let i = 0; i < convs.length; i += 100) {
    // 1000行ずつの頁（100会話の30日分は 1000 を超える＝前は切れて書き手が unknown になり、竹内さんの番が少なく数えられていた）
    const data: Array<Record<string, unknown>> = [];
    for (let j = 0; ; j += 1000) {
      const { data: pg, error: e2 } = await sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated").in("conversation_id", convs.slice(i, i + 100)).neq("sender", "customer").gte("created_at", since).order("created_at", { ascending: true }).range(j, j + 999);
      if (e2) throw new Error(e2.message);
      data.push(...((pg ?? []) as Array<Record<string, unknown>>));
      if ((pg ?? []).length < 1000) break;
    }
    for (const m of data) { const a = staffMsgs.get(m.conversation_id as string) ?? []; a.push({ at: Date.parse(m.created_at as string), writer: (m.staff_writer as string | null) ?? null, isAix: !!(m as { is_aix_generated?: boolean | null }).is_aix_generated }); staffMsgs.set(m.conversation_id as string, a); }
  }
  const writerOf = (w: W): string => { const t = Date.parse(w.customer_turn_at); const first = (staffMsgs.get(w.conversation_id) ?? []).filter((m) => m.at >= t && m.at - t < 86_400_000).sort((a, b) => a.at - b.at)[0]; return first?.writer ?? "unknown"; };
  const byWriter = new Map<string, { n: number; hit: number }>();
  const byScene = new Map<string, { n: number; hit: number }>();
  const bySceneTk = new Map<string, { n: number; hit: number }>();
  const fieldSeen: Record<string, { n: number; hit: number }> = {}; const fieldNot: Record<string, { n: number; hit: number }> = {};
  let ciN = 0, ciDs = 0, ciDsScene = 0;
  // 2026-11-04 作業員1（統括役の指示・q201／番 10415 の気付き）: 物差しはこちらの「最初の一手」（番の後の最初の送信が AIX か返信か・AIX ならその種類）。
  //   前の数え方（staff_aix の中の最初の AIX）は、確認の約束の返信の後に押した AIX を一手と数えて、その場の AIX（ブレインの外れ）を当たりにしていた。差は下に一覧で出す
  const changed: string[] = [];
  for (const w of turns) {
    const oldStaff = (w.staff_aix ?? []).find((a) => a.burst !== false)?.aix_type ?? null;
    const oldHit = aixFamily(w.brain_action) === aixFamily(oldStaff);
    const fm = staffFirstMove(Date.parse(w.customer_turn_at), staffMsgs.get(w.conversation_id) ?? [], aixLogsFromWatch(w.staff_aix));
    const staff = fm?.kind === "aix" ? fm.aix : null;
    const hit = aixFamily(w.brain_action) === aixFamily(staff);
    if (hit !== oldHit) changed.push(`${w.id}（${writerOf(w)}・${w.scene_key ?? "場面なし"}）: ブレイン ${aixFamily(w.brain_action)}／前の一手 ${aixFamily(oldStaff)}→最初の一手 ${aixFamily(staff)}：${oldHit ? "当たり→外れ" : "外れ→当たり"}`);
    const sc = w.scene_key ?? "（場面なし）";
    const v = byScene.get(sc) ?? { n: 0, hit: 0 }; v.n++; if (hit) v.hit++; byScene.set(sc, v);
    const wr = writerOf(w); const bw = byWriter.get(wr) ?? { n: 0, hit: 0 }; bw.n++; if (hit) bw.hit++; byWriter.set(wr, bw);
    if (wr === "takeuchi") { const t = bySceneTk.get(sc) ?? { n: 0, hit: 0 }; t.n++; if (hit) t.hit++; bySceneTk.set(sc, t); }
    const d = dg.get(w.decision_id) ?? {};
    for (const f of RECORD_FIELDS) {
      const bag = d[f] != null && d[f] !== "" ? fieldSeen : fieldNot;
      const x = bag[f] ?? { n: 0, hit: 0 }; x.n++; if (hit) x.hit++; bag[f] = x;
    }
    const ci = typeof d.ci === "string" ? d.ci : null;
    if (ci) { ciN++; const m = ci.match(/\|ds:(.)/); if (m) { ciDs++; if (m[1] === "s") ciDsScene++; } }
  }
  const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");
  const total = [...byScene.values()].reduce((a, v) => ({ n: a.n + v.n, hit: a.hit + v.hit }), { n: 0, hit: 0 });
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ days: DAYS, n: total.n, hit: total.hit, byWriter: Object.fromEntries(byWriter), bySceneTakeuchi: Object.fromEntries(bySceneTk), byScene: Object.fromEntries(byScene), fieldSeen, fieldNot, ci: { n: ciN, ds: ciDs, dsScene: ciDsScene } })); return; }
  const tk = byWriter.get("takeuchi") ?? { n: 0, hit: 0 };
  console.log(`# 本番の記録を試験に使う（直近${DAYS}日・見張りの番 ${total.n}・判断の当たり ${pct(total.hit, total.n)}）`);
  console.log(`## 主の数字＝竹内さん本人の番: ${tk.hit}/${tk.n}（${pct(tk.hit, tk.n)}）／書き手ごと: ${[...byWriter].map(([k, v]) => `${k} ${v.hit}/${v.n}（${pct(v.hit, v.n)}）`).join("・")}`);
  console.log("\n## 竹内さんの番の場面ごとの当たり（基準は竹内さん本人の番だけ・5未満の場面は「少ない」で待つか確認事項で聞く＝従業員の番で埋めない・KB 41dadfe6）");
  for (const [k, v] of [...bySceneTk].sort((a, b) => b[1].n - a[1].n)) console.log(`- ${k}: ${v.hit}/${v.n}（${pct(v.hit, v.n)}）${v.n < 5 ? "・少ない（待つ／竹内さんに聞く）" : ""}`);
  console.log("\n## 参考（基準ではない）: 全スタッフの場面ごとの当たり（ブレインの道の系統 × スタッフの一手の系統）");
  for (const [k, v] of [...byScene].sort((a, b) => b[1].n - a[1].n)) console.log(`- ${k}: ${v.hit}/${v.n}（${pct(v.hit, v.n)}）`);
  console.log("\n## ②④ 記録だけの欄（出た番の数・出た番と出なかった番の当たり）");
  for (const f of RECORD_FIELDS) { const s = fieldSeen[f] ?? { n: 0, hit: 0 }, o = fieldNot[f] ?? { n: 0, hit: 0 }; console.log(`- ${f}: 出た ${s.n}番（当たり ${pct(s.hit, s.n)}）／出なかった ${o.n}番（${pct(o.hit, o.n)}）`); }
  console.log(`\n## 物差しの直し（11/04・最初の一手で比べる）で当たり／外れが変わった番 ${changed.length}`);
  for (const c of changed) console.log(`- ${c}`);
  console.log(`\n## ③ 入口の読み: 記録 ${ciN}番・DeepSeek と比べた ${ciDs}番・場面が合った ${ciDsScene}（${pct(ciDsScene, ciDs)}）`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
