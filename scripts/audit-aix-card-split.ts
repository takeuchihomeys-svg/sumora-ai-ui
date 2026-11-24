// scripts/audit-aix-card-split.ts — AIX の取り違えの組ごとに、状態の札（app/lib/aix-state-card.ts）のどの欄が分かれ目かを数える（台帳 #688・読むだけ・LLM なし・夜の重い読み）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-card-split.ts --from=<audit-aix-miss-causes の --json（--hits=N つき）>
// 2026-11-25 作業員A（竹内さん 11/25 深夜「AIX の判断の部分は土台を足して細分化して強化」・統括役の頼み）
//   外れ（ブレイン A → スタッフ B）と当たり（スタッフ B を押してブレインも B）の番ごとに、番の時刻で札を作り、組ごとの分かれ目の欄の値を数える。
//   竹内さん本人の番（staff_writer=takeuchi）だけで過半数（n≥10）を見る。④ スタッフだけが知る番は外して別に数える
import { readFileSync } from "node:fs";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { cutAt } from "./lib/route-locate-at";
import { buildAixStateCard, type AixStateCard } from "../app/lib/aix-state-card";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
type M = { conversation_id: string; customer_turn_at: string; customer_last_at?: string | null; cause: string; staff_aix: string | null; staff_writer: string; brain_action: string | null; brain_reply_mode: string | null };
const j = JSON.parse(readFileSync(arg("from"), "utf8")) as { misses: M[]; hits: M[] };
// 組 → 分かれ目の欄（札の欄で、竹内さんの選び方を分けると考えられる物）
const SPLITS: Record<string, { label: string; of: (c: AixStateCard) => string }> = {
  "property_send|property_recommendation": { label: "束を最後に送ってから1時間以内か", of: (c) => (c.bundle.lastMinAgo === null ? "束なし" : c.bundle.lastMinAgo <= 60 ? "1時間以内" : "1時間超") },
  "viewing_invite|meeting_place": { label: "候補日を出したか・日時が決まったか", of: (c) => (c.viewing.decided ? "決まった" : c.viewing.invitedMinAgo !== null ? "候補日を出した" : "候補日なし") },
  "estimate_sheet|property_check_result": { label: "空室を確かめたか（見積書より前）", of: (c) => (c.estimate.checkMinAgo === null ? "確かめていない" : c.estimate.checkResult ?? "確かめた") },
  "acknowledge_check|property_check_result": { label: "管理会社の確認が開いているか", of: (c) => (c.mgmt.openCheckTasks > 0 ? "開いている" : "開いていない") },
};
const pairKey = (a: string | null, b: string | null) => { const k1 = `${a ?? ""}|${b ?? ""}`, k2 = `${b ?? ""}|${a ?? ""}`; return SPLITS[k1] ? k1 : SPLITS[k2] ? k2 : null; };
(async () => {
  const rows = [...j.misses.map((m) => ({ ...m, hit: false })), ...j.hits.map((m) => ({ ...m, hit: true }))];
  const tally = new Map<string, Map<string, { takeuchi: number; all: number; staffOnly: number }>>();
  const cache = new Map<string, Awaited<ReturnType<typeof loadCustomerStateInput>>>();
  let used = 0;
  for (const r of rows) {
    const staff = r.staff_aix; if (!staff) continue;
    // 当たりは「スタッフ B・ブレインも B」＝その B が入る組すべての当たりとして数える。外れは A→B の組
    const keys = r.hit ? Object.keys(SPLITS).filter((k) => k.split("|").includes(staff)) : [pairKey(r.brain_action, staff)].filter((x): x is string => !!x);
    if (!keys.length) continue;
    let input = cache.get(r.conversation_id);
    if (input === undefined) { try { input = await loadCustomerStateInput(r.conversation_id); } catch { input = null; } cache.set(r.conversation_id, input); }
    if (!input) continue;
    const t = Date.parse(r.customer_last_at ?? r.customer_turn_at) + 1000;
    const card = buildAixStateCard(cutAt(input, t), t);
    used++;
    for (const k of keys) {
      const v = `${SPLITS[k].of(card)}→スタッフ ${staff}${r.hit ? "（当たり）" : `（外れ: ブレイン ${r.brain_action}）`}`;
      const m = tally.get(k) ?? new Map(); const x = m.get(v) ?? { takeuchi: 0, all: 0, staffOnly: 0 };
      if (r.cause?.startsWith("④")) x.staffOnly++; else { x.all++; if (r.staff_writer === "takeuchi") x.takeuchi++; }
      m.set(v, x); tally.set(k, m);
    }
  }
  console.log(`■ 札の分かれ目（番 ${used}・外れ ${j.misses.length}・当たり ${j.hits.length}・④ スタッフだけが知る番は別に数える）`);
  for (const [k, m] of tally) {
    console.log(`\n  ${k.replace("|", " ⇄ ")}（分かれ目: ${SPLITS[k].label}）`);
    for (const [v, x] of [...m].sort((a, b) => b[1].all - a[1].all)) console.log(`    ${v}: ${x.all}番（竹内さん本人 ${x.takeuchi}）${x.staffOnly ? `・④ ${x.staffOnly}` : ""}`);
    const tk = [...m.values()].reduce((s, x) => s + x.takeuchi, 0);
    console.log(`    → 竹内さん本人の番 ${tk}${tk >= 10 ? "（n≥10・過半数の形を見る）" : "（n<10＝数を待つ）"}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
