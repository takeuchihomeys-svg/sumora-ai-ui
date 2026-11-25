// scripts/audit-route-station-read.ts — 弱い駅の番を1番ずつ、AIX の状態の札で照らして原因を3つ（材料が無い・読み違い・数え方）に分ける（台帳 #687・読むだけ・LLM なし・夜の重い読み）
// 実行: npx tsx --env-file=.env.local scripts/audit-route-station-read.ts --from=<audit-route-progress-takeuchi の json> --node=viewing_scheduled
// 2026-11-25 作業員A（統括役の頼み: 一番弱い駅「内覧予定」）
//   分け方（決まった計算・上から）:
//     数え方 … 地図の候補が「当日のご挨拶」で、札で内覧が今日でない（1日以上先・日付が無い）＝当日でない番に当日の一手を候補にしていた（地図の側の数え方）
//     材料が無い … 札で内覧の予定（カレンダー）が無いのに内覧予定の駅に置いた＝日時の材料が判断に無い
//     読み違い … 材料はあり（内覧が今日／予定あり）、地図の候補と竹内さんの一手が違う
//   竹内さんの一手と札の欄（何日後・今日の挨拶・番の型）を組で数え、n≥10 の過半数がある組だけ直しの候補
import { readFileSync } from "node:fs";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { cutAt } from "./lib/route-locate-at";
import { buildAixStateCard } from "../app/lib/aix-state-card";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
type Row = { conv: string; at: string; node: string | null; branch: string | null; act: string; agree: string; nextAix?: string[] | null; rt?: string | null; sub1?: string | null; outcome?: string | null };
const rows = (JSON.parse(readFileSync(arg("from"), "utf8")) as Row[]).filter((r) => r.node === (arg("node") || "viewing_scheduled") && !r.branch);
(async () => {
  const MATCH = new Set(["aix_match", "promise_match", "reply_match", "reply_invite"]);
  const out: Array<{ r: Row; cause: string; daysTo: number | null; greet: boolean; key: string }> = [];
  const memo = new Map<string, Awaited<ReturnType<typeof loadCustomerStateInput>>>();
  for (const r of rows) {
    // conv は頭8字。会話を探す（同じ頭8字の会話は1つの前提）
    let input = memo.get(r.conv);
    if (input === undefined) { try { const { createClient } = await import("@supabase/supabase-js"); const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""); const { data } = await sb.from("conversations").select("id").like("id::text" as never, `${r.conv}%`).limit(1); const id = (data?.[0] as { id?: string } | undefined)?.id; input = id ? await loadCustomerStateInput(id) : null; } catch { input = null; } memo.set(r.conv, input); }
    const t = Date.parse(r.at) + 1000;
    const card = input ? buildAixStateCard(cutAt(input, t), t) : null;
    const daysTo = card?.viewing.daysTo ?? null, greet = !!card?.viewing.greetingToday;
    const cand = (r.nextAix ?? []).join("・");
    let cause: string;
    if (MATCH.has(r.agree)) cause = "合う";
    else if (cand.includes("greeting_viewing") && (daysTo === null || daysTo >= 1)) cause = "数え方（当日でない番に当日のご挨拶）";
    else if (!card || daysTo === null) cause = "材料が無い（内覧の予定が判断に無い）";
    else cause = "読み違い";
    const key = `${daysTo === null ? "予定なし" : daysTo === 0 ? "今日" : daysTo === 1 ? "明日" : "2日以上先"}｜${r.rt ?? "-"}`;
    out.push({ r, cause, daysTo, greet, key });
  }
  const c = new Map<string, number>(); for (const o of out) c.set(o.cause, (c.get(o.cause) ?? 0) + 1);
  console.log(`■ 内覧予定の駅（竹内さん本人の番 ${out.length}）の原因: ${[...c].map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`\n■ 札の分かれ目（内覧が何日後｜番の型）× 竹内さんの一手`);
  const g = new Map<string, Map<string, number>>();
  for (const o of out) { const m = g.get(o.key) ?? new Map(); m.set(o.r.act, (m.get(o.r.act) ?? 0) + 1); g.set(o.key, m); }
  for (const [k, m] of [...g].sort((a, b) => [...b[1].values()].reduce((s, x) => s + x, 0) - [...a[1].values()].reduce((s, x) => s + x, 0))) {
    const n = [...m.values()].reduce((s, x) => s + x, 0); const top = [...m].sort((a, b) => b[1] - a[1])[0];
    console.log(`  ${k}: ${n}番・竹内さん ${[...m].map(([a, v]) => `${a} ${v}`).join("・")}${n >= 10 && top[1] * 2 > n ? `　← n≥10 の過半数（${top[0]}）＝直しの候補` : n >= 10 ? "　（割れ）" : "　（n<10）"}`);
  }
  console.log(`\n■ 番ごと（会話の頭8字・時刻・地図の候補→竹内さん・札）`);
  for (const o of out) console.log(`  ${o.r.conv} ${o.r.at.slice(5, 16)} ${(o.r.nextAix ?? []).join("・") || "-"}→${o.r.act}｜内覧 ${o.daysTo ?? "予定なし"}日後・今日の挨拶 ${o.greet ? "済" : "未"}｜${o.cause}`);
})().catch((e) => { console.error(e); process.exit(1); });
