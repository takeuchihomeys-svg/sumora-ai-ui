// scripts/audit-ask-route-takeuchi.ts — 竹内さんの実際の送信で「要件→行き先」の型を数える（読むだけ・LLM なし・費用 0・2026-11-15 作業員M）
//   竹内さん 11/15「どの部分を返信で答えているか、どの部分は AIX で送る必要があるから AIX で送るかを把握する。細かく細分化して強化」。
//   ブレインの要件の行き先（brain_decision_logs.digest.tc＝要件の数と route の内訳 r/p/a/n）×ブレインの最終の AIX と、
//   竹内さん本人の番（その番の手が全部 竹内さん）の実際の送信（返信の通・AIX の種類と数・順番）を並べ、型と外れを数える。
//   外れの型（要件の帳面 app/lib/ask-ledger.ts の3つに合わせる）:
//     取りこぼし（AIX 側）  … 竹内さんは AIX を送ったのに、ブレインの要件に AIX も約束も無い
//     取りこぼし（2つ目の AIX）… 竹内さんは AIX を2種類以上送ったのに、ブレインの要件の AIX は1つ以下（組み立ては AIX の席を1つしか持たない）
//     取り違え（AIX→返信）  … ブレインの要件は AIX なのに、竹内さんは返信だけ（AIX は次の番以降）
//     取り違え（返信→AIX）  … ブレインの要件は返信だけなのに、竹内さんは AIX だけ
//     重ねの候補            … ブレインは返信と AIX の両方の要件・竹内さんは1通だけ
//   物件オススメ＋物件ピックアップ（property_recommendation＋property_send）は1つの束として1種類に数える（オススメ1＋9 の型）。
//   申込以降の会話は外す。営業時間（JST 9〜22時）は流さない。本文は出さない（数と会話 id の頭8字だけ）。
//   実行: npx tsx --env-file=<鍵のある .env> scripts/audit-ask-route-takeuchi.ts [--days=60] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { readWatchTurns } from "./lib/prod-yardstick-db";
import { tcMix, sendShape, outlierOf, aixBundleFamily as fam, causeOf, aixKindMismatch, ledgerClassOf } from "./lib/ask-route-of";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = (new Date().getUTCHours() + 9) % 24;
if (jstHour >= 9 && jstHour < 22) { console.error("営業時間（JST 9〜22時）は流さない"); process.exit(1); }
const days = Number(arg("days", "60")) || 60;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const POST_APPLY_RE = /記入欄】|・氏名、フリガナ|申込(?:み)?(?:用)?フォーマット|お申込に必要なご情報|ご本人確認書類として|審査(?:結果|が通|通過しました)|ご契約(?:書|手続)/;

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const turns = await readWatchTurns(sb, since);
  const convs = [...new Set(turns.map((t) => t.conversation_id))];
  type M = { at: number; aix: boolean; writer: string | null; customer: boolean; text: string };
  const msgs = new Map<string, M[]>();
  for (let i = 0; i < convs.length; i += 50) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, sender, staff_writer, is_aix_generated, text").in("conversation_id", convs.slice(i, i + 50)).gte("created_at", since).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const a = msgs.get(r.conversation_id as string) ?? [];
        a.push({ at: Date.parse(r.created_at as string), aix: !!r.is_aix_generated, writer: (r.staff_writer as string | null) ?? null, customer: r.sender === "customer", text: String(r.text ?? "") });
        msgs.set(r.conversation_id as string, a);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  const ids = [...new Set(turns.map((t) => t.decision_id).filter((x): x is string => !!x))];
  const tcOf = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("brain_decision_logs").select("id, digest").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; digest: { tc?: string } | null }>) tcOf.set(r.id, r.digest?.tc ?? null);
  }
  const table = new Map<string, number>();
  const outliers = new Map<string, Array<{ conv: string; at: string; scene: string; brain: string; staff: string }>>();
  let takeuchi = 0, skipped = 0;
  // 2026-11-18 統括役の割り当て（W46 の当たりの低い場面）: 場面（line_watch_turns.scene_key）ごとに、帳面の3つ×原因の3つで数える
  const byScene = new Map<string, { n: number; cells: Map<string, number> }>();
  const focus = arg("scenes", "返信:条件提示,返信:短い了承・お礼,AIX:estimate_sheet").split(",").filter(Boolean);
  for (const t of turns) {
    const at = Date.parse(t.customer_turn_at);
    const all = msgs.get(t.conversation_id) ?? [];
    if (all.some((m) => !m.customer && m.at <= at + 86_400_000 && POST_APPLY_RE.test(m.text))) { skipped++; continue; }
    const moves: M[] = [];
    for (const m of all.filter((x) => x.at > at)) { if (m.customer || m.at - at >= 86_400_000) break; moves.push(m); }
    if (!moves.length || !moves.every((m) => m.writer === "takeuchi")) continue;
    takeuchi++;
    const mix = tcMix(t.decision_id ? tcOf.get(t.decision_id) : null);
    const shape = sendShape(moves);
    const kinds = [...new Set((t.staff_aix ?? []).map((a) => fam(String(a.aix_type ?? ""))).filter(Boolean))];
    const brainMix = mix ? `${mix.r ? "R" : ""}${mix.p ? "P" : ""}${mix.a ? (mix.a > 1 ? `A${mix.a}` : "A") : ""}` || "要件は触れないだけ" : "記録なし";
    const key = `${brainMix} → ${shape}${kinds.length >= 2 ? `（AIX ${kinds.length}種）` : ""}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    let o = outlierOf(mix, shape, kinds.length);
    // 2026-11-18 夜の数えの読み: 要件に AIX が無くても、ブレインの最終の AIX が竹内さんの AIX と同じ束なら道は合う
    //   （前の約束を果たす AIX＝お客様の今の要件の外。要件の帳面には席だけあって要件が無い＝seat_only）
    if (o === "取りこぼし（AIX 側）" && t.brain_action && kinds.length && !aixKindMismatch(t.brain_action, kinds)) o = "合う（AIX は要件の外＝前の約束を果たす）";
    // 2026-11-18 夜の数えを1通ずつ読んだ結果（お礼の番 5件のうち3件）: 了承・お礼の番の後、何時間も後に送った AIX は前の約束の果たし（確認の結果・ピックアップ）＝この番への答えではない。
    //   1時間より後の最初の AIX で、それより前に AIX が無ければ番の外として数える（audit-combo-mismatch の「果たしの AIX は番の外」と同じ見方）
    const firstAix = moves.find((m) => m.aix);
    if (o === "取りこぼし（AIX 側）" && firstAix && firstAix.at - at > 60 * 60_000) o = "合う（AIX は1時間より後＝前の約束の果たし・番の外）";
    if (/^記録なし$|^要件の記録なし$/.test(o) && t.customer_turn_at < "2026-10-09") o = "要件の記録なし（digest に要件の欄が無い頃・10/08 より前）";
    if (o === "合う" && shape.includes("A") && aixKindMismatch(t.brain_action, kinds)) o = "AIX の種類が違う";
    const sk = String(t.scene_key ?? "（場面なし）");
    const srow = byScene.get(sk) ?? { n: 0, cells: new Map<string, number>() };
    srow.n++;
    const cell = `${ledgerClassOf(o)}／${causeOf(o)}`;
    srow.cells.set(cell, (srow.cells.get(cell) ?? 0) + 1);
    byScene.set(sk, srow);
    if (o !== "合う") outliers.set(o, [...(outliers.get(o) ?? []), { conv: t.conversation_id.slice(0, 8), at: t.customer_turn_at.slice(5, 16), scene: String(t.scene_key ?? ""), brain: `${brainMix}/${t.brain_action ?? "返信"}`, staff: `${shape}/${kinds.join("+")}` }]);
  }
  console.log(`# 要件→行き先（竹内さん本人の番・直近 ${days}日・見張りの番 ${turns.length}・竹内さんの番 ${takeuchi}・申込以降で外した ${skipped}）`);
  console.log("\n## 型（ブレインの要件の行き先 R=返信 P=約束 A=AIX → 竹内さんの送信の並び）");
  for (const [k, n] of [...table].sort((a, b) => b[1] - a[1])) console.log(`- ${k}: ${n}`);
  console.log("\n## 外れ");
  for (const [k, list] of [...outliers].sort((a, b) => b[1].length - a[1].length)) {
    const sc = new Map<string, number>(); for (const r of list) sc.set(r.scene, (sc.get(r.scene) ?? 0) + 1);
    console.log(`- ${k}: ${list.length}（場面 ${[...sc].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${s || "なし"} ${n}`).join("・")}）`);
    for (const r of list.slice(0, 4)) console.log(`    · ${r.at} ${r.conv} ブレイン ${r.brain} ／ 竹内さん ${r.staff}`);
  }
  console.log("\n## 場面ごと（帳面の3つ／原因の3つ・目安の振り分け＝読んで直す前）");
  const scenes = [...byScene].sort((a, b) => b[1].n - a[1].n);
  for (const [sk, row] of [...scenes.filter(([k]) => focus.includes(k)), ...scenes.filter(([k]) => !focus.includes(k)).slice(0, 12)]) {
    const ok = row.cells.get("合う／合う") ?? 0;
    const rest = [...row.cells].filter(([c]) => c !== "合う／合う").sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join("・");
    console.log(`- ${focus.includes(sk) ? "★" : ""}${sk}: ${row.n}番・合う ${ok}（${Math.round((ok / row.n) * 100)}%）・${rest}`);
  }
  for (const sk of focus) for (const [k, list] of outliers) {
    const xs = list.filter((r) => r.scene === sk);
    if (!xs.length) continue;
    console.log(`  ★${sk} の ${k}: ${xs.length}`);
    for (const r of xs.slice(0, 3)) console.log(`    · ${r.at} ${r.conv} ブレイン ${r.brain} ／ 竹内さん ${r.staff}`);
  }
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ days, takeuchi, table: Object.fromEntries(table), outliers: Object.fromEntries(outliers) }, null, 1));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
