// scripts/conductor-focus-prod-check.ts — 本番の shadow の重点（digest.fc）が、スタッフの実際の一手の重点と合うか（LLM なし・読むだけ・作業員5・11/07）
//   統括役（竹内さん「統括のブレインの効かせ方はちゃんと動けているか」）: ① 場面ごとに合った割合 ② 重点とブレインの最終の道の食い違い。
//   正解の重点: 竹内さんの解剖（takeuchi_compose_examples.anatomy.focus）がその番にあればそれ・無ければ決まった札（focusOfTakeuchiTurn・解剖との一致は約5割＝参考）。
//   読み: line_watch_turns（直近 --days・最大 1000行）＋brain_decision_logs（decision_id で 200件ずつ）＋解剖（会話ごと 200件ずつ）。
// 実行: npx tsx --env-file=.env.local scripts/conductor-focus-prod-check.ts [--days=3] [--json]
import { createClient } from "@supabase/supabase-js";
import { focusOfTakeuchiTurn, focusOfAix, focusConflict, focusHumanOnlyMiss, FOCUS_KINDS, type Focus } from "../app/lib/conductor-focus";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Math.max(1, Math.min(14, Number(arg("days", "3")) || 3));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
type Turn = { id: string; conversation_id: string; scene_key: string | null; decision_id: string | null; staff_first_at: string | null; staff_texts: { at: string; text: string }[] | null; staff_aix: { at: string; aix_type: string | null }[] | null; brain_action: string | null; brain_reply_mode: string | null };
type Dec = { id: string; digest: Record<string, unknown> | null; suggested_action: string | null; suggested_reply_mode: string | null };
const isFocus = (v: unknown): v is Focus => typeof v === "string" && (FOCUS_KINDS as readonly string[]).includes(v);

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: tData, error } = await sb.from("line_watch_turns").select("id, conversation_id, scene_key, decision_id, staff_first_at, staff_texts, staff_aix, brain_action, brain_reply_mode")
    .gte("customer_turn_at", since).not("staff_first_at", "is", null).order("customer_turn_at", { ascending: true }).range(0, 999);
  if (error) throw new Error(error.message);
  const turns = (tData ?? []) as Turn[];
  const decIds = [...new Set(turns.map((t) => t.decision_id).filter(Boolean) as string[])];
  const decs = new Map<string, Dec>();
  for (let i = 0; i < decIds.length; i += 200) {
    const { data, error: e } = await sb.from("brain_decision_logs").select("id, digest, suggested_action, suggested_reply_mode").in("id", decIds.slice(i, i + 200));
    if (e) throw new Error(e.message);
    for (const d of (data ?? []) as Dec[]) decs.set(d.id, d);
  }
  // 解剖の重点（その番の最初のスタッフの送信の前後3分）
  const convs = [...new Set(turns.map((t) => t.conversation_id))];
  const anat = new Map<string, { at: number; focus: Focus | null }[]>();
  for (let i = 0; i < convs.length; i += 200) {
    const { data, error: e } = await sb.from("takeuchi_compose_examples").select("conversation_key, sent_at, anatomy").in("conversation_key", convs.slice(i, i + 200)).gte("sent_at", since).range(0, 999);
    if (e) { console.error(`解剖は読めない（${e.message}）→ 決まった札だけで数える`); break; }
    for (const r of (data ?? []) as { conversation_key: string; sent_at: string; anatomy: { focus?: unknown; focus_votes?: unknown } | null }[]) {
      // 11/07: 3回読みで割れた番（focus=null・focus_votes あり）は正解なし＝数えない（決まった札にも落とさない）
      const split = r.anatomy?.focus == null && Array.isArray(r.anatomy?.focus_votes);
      if (!isFocus(r.anatomy?.focus) && !split) continue;
      (anat.get(r.conversation_key) ?? anat.set(r.conversation_key, []).get(r.conversation_key)!).push({ at: Date.parse(r.sent_at), focus: split ? null : (r.anatomy!.focus as Focus) });
    }
  }
  type Row = { scene: string; fc: Focus; gold: Focus | null; goldBy: "anatomy" | "rule" | null; conflict: string | null; finalAix: string | null };
  const rows: Row[] = [];
  let noFc = 0;
  for (const t of turns) {
    const d = t.decision_id ? decs.get(t.decision_id) : undefined;
    const fcRaw = String((d?.digest as { fc?: unknown } | null)?.fc ?? "").split("|")[0];
    if (!isFocus(fcRaw)) { noFc++; continue; }
    const firstAt = Date.parse(t.staff_first_at as string);
    const aix0 = (t.staff_aix ?? []).slice().sort((a, b) => a.at.localeCompare(b.at))[0];
    const txt0 = (t.staff_texts ?? []).slice().sort((a, b) => a.at.localeCompare(b.at))[0];
    const route: "aix" | "reply" = aix0 && (!txt0 || aix0.at <= txt0.at) ? "aix" : "reply";
    const a = (anat.get(t.conversation_id) ?? []).filter((x) => Math.abs(x.at - firstAt) <= 3 * 60_000).sort((x, y) => Math.abs(x.at - firstAt) - Math.abs(y.at - firstAt))[0];
    const rule = focusOfTakeuchiTurn({ route, aixType: aix0?.aix_type ?? null, text: txt0?.text ?? "" });
    const gold = a ? a.focus : rule;
    const finalAix = (t.brain_reply_mode ?? d?.suggested_reply_mode) === "aix" ? (t.brain_action ?? d?.suggested_action ?? null) : null;
    rows.push({ scene: t.scene_key ?? "(場面なし)", fc: fcRaw, gold, goldBy: a ? "anatomy" : gold ? "rule" : null, conflict: focusConflict(fcRaw, { aix: finalAix }), finalAix });
  }
  const by = new Map<string, { n: number; hit: number; anat: number; anatHit: number; human: number }>();
  for (const r of rows) {
    if (!r.gold) continue;
    for (const k of ["(全体)", r.scene]) {
      const s = by.get(k) ?? { n: 0, hit: 0, anat: 0, anatHit: 0, human: 0 }; by.set(k, s);
      // 人だけが知る事で分かれる外れ（了承の番の relation と promise_keep）は当たりの分母から外して別に数える（focusHumanOnlyMiss・11/07 統括役）
      if (focusHumanOnlyMiss(r.fc, r.gold)) { s.human++; continue; }
      s.n++; if (r.fc === r.gold) s.hit++;
      if (r.goldBy === "anatomy") { s.anat++; if (r.fc === r.gold) s.anatHit++; }
    }
  }
  // ②b ブレインの最終の道が AIX の番: その AIX の重点（focusOfAix）と統括の重点が違う番
  const aixRows = rows.filter((r) => r.finalAix && focusOfAix(r.finalAix));
  const aixDiff = aixRows.filter((r) => focusOfAix(r.finalAix) !== r.fc).length;
  const conflicts = rows.filter((r) => r.conflict);
  const confKinds = conflicts.reduce<Record<string, number>>((m, r) => ((m[r.conflict!] = (m[r.conflict!] ?? 0) + 1), m), {});
  const fcDist = rows.reduce<Record<string, number>>((m, r) => ((m[r.fc] = (m[r.fc] ?? 0) + 1), m), {});
  const pairs = rows.filter((r) => r.gold && r.fc !== r.gold).reduce<Record<string, number>>((m, r) => { const k = `${r.fc}→${r.gold}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const out = { days, turns: turns.length, withFc: rows.length, noFc, withGold: rows.filter((r) => r.gold).length, byAnatomy: rows.filter((r) => r.goldBy === "anatomy").length,
    scenes: [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([scene, s]) => ({ scene, ...s, pct: s.n ? Math.round((100 * s.hit) / s.n) : null })),
    conflicts: conflicts.length, confKinds, aixTurns: aixRows.length, aixDiff, fcDist, missPairs: Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 8) };
  if (process.argv.includes("--json")) { console.log(JSON.stringify(out)); return; }
  console.log(`直近 ${days}日・スタッフが返した番 ${out.turns}・重点が付いた番 ${out.withFc}（無し ${noFc}）・正解の重点あり ${out.withGold}（うち解剖 ${out.byAnatomy}）`);
  console.log("| 場面 | 番（人だけの外れを除く） | 合った | 割合 | 人だけが知る事で分かれた | 解剖の番 | 解剖で合った |\n|---|---|---|---|---|---|---|");
  for (const s of out.scenes) console.log(`| ${s.scene} | ${s.n} | ${s.hit} | ${s.pct}% | ${s.human} | ${s.anat} | ${s.anatHit} |`);
  console.log(`重点の分かれ: ${JSON.stringify(fcDist)}`);
  console.log(`外れの向き（重点→正解）: ${out.missPairs.map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`② 重点と最終の道の食い違い: ${conflicts.length}番 ${JSON.stringify(confKinds)}・最終が AIX の番 ${aixRows.length}番のうち、その AIX の重点と違う ${aixDiff}番`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
