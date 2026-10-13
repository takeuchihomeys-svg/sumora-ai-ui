// scripts/audit-final-check-unfixed.ts — 「指摘が画面に出ているのに下書きが直っていない」を数える（読むだけ・LLM なし）
//
// 2026-10-13 竹内さん「最終チェックの部分でも、指摘のアナウンスでブレインが正しいが、実際の文が修正されていないことが良くある」。
//   ① line_watch_turns（番ごとの最終チェックの控え: 最後に残った指摘の code・引用・段）× 同じ番の送った例の記録（ブレインが読んだ質問）で、
//      残った指摘ごとに「旧の選び方で書き直しに渡ったか」「新の選び方（final-check-brain-align）で渡るか」を分ける
//   ② conversations.ai_draft_check（会話ごとの最新・指摘の文まで残る）× last_brain_meta の本質で、ブレインとぶつかる指摘・ブレインが裏付ける指摘を数える（本質の時刻は最新＝近似）
//   ③ 送った例の記録の finalCheckGate.revisionDropped（書き直しを採らなかった理由）の内訳
// 実行: npx tsx --env-file=.env.local scripts/audit-final-check-unfixed.ts [--days=30] [--detail]
import { createClient } from "@supabase/supabase-js";
import { classifyIssueScope } from "../app/lib/final-check-scope";
import { evidenceAnchoredInDraft, brainBacksIssue, type AlignIssue } from "../app/lib/final-check-brain-align";
import { issueContradictsContract, buildTurnContract } from "../app/lib/turn-contract";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "30"));
const DETAIL = process.argv.includes("--detail");
const HELD = process.argv.includes("--held");
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString();
const TEST_IDS = new Set(["dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"]);
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function page(table: string, select: string, build: (q: any) => any): Promise<Row[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Row[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await build(sb.from(table).select(select)).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const legacyAnchored = (ev: string, draft: string) => !ev || draft.replace(/\s+/g, "").includes(ev.replace(/\s+/g, ""));
const shownIssue = (i: Row) => i && i.severity !== "info" && classifyIssueScope(String(i.code)) !== "style" && i.code !== "UNCHECKED_AUTO_SEND" && i.code !== "CELL_AVOID_CONFLICT" && i.pass !== "meta";

async function main() {
  console.log(`=== 指摘が残った下書き（${SINCE.slice(0, 10)}〜・テスト会話を除く）===\n`);
  // ── ① 番ごと ──
  const turns = (await page("line_watch_turns", "id, conversation_id, customer_turn_at, draft_last, final_check", (q) => q.gte("customer_turn_at", SINCE).not("final_check", "is", null).order("customer_turn_at")))
    .filter((t) => !TEST_IDS.has(t.conversation_id) && !String(t.conversation_id).startsWith("test-"));
  const ex = await page("ai_reply_examples", "conversation_id, created_at, reply_context_snapshot", (q) => q.gte("created_at", SINCE).eq("entry_source", "line_reply"));
  const cqOf = (t: Row): string[] => {
    const at = new Date(t.customer_turn_at).getTime();
    const near = ex.filter((e) => e.conversation_id === t.conversation_id && Math.abs(new Date(e.created_at).getTime() - at) < 6 * 3600e3)
      .sort((a, b) => Math.abs(new Date(a.created_at).getTime() - at) - Math.abs(new Date(b.created_at).getTime() - at))[0];
    return (near?.reply_context_snapshot?.brainCustomerQuestions ?? []) as string[];
  };
  let withShown = 0, nIssues = 0;
  const byCls = new Map<string, number>(); const byCode = new Map<string, { n: number; oldPass: number; newPass: number; bb: number }>();
  const turnsNewFixable = new Set<number>(); const turnsOldPassable = new Set<number>();
  const samples: string[] = []; const heldSamples: string[] = [];
  for (const t of turns) {
    const iss = ((t.final_check?.issues ?? []) as Row[]).filter(shownIssue);
    if (!iss.length) continue;
    withShown++;
    const draft = String(t.draft_last ?? "");
    const cq = cqOf(t);
    for (const i of iss) {
      nIssues++;
      const ev = String(i.evidence ?? "");
      const oldP = legacyAnchored(ev, draft);
      const anch = evidenceAnchoredInDraft(ev, draft);
      // ⚠ line_watch_turns の控えには指摘の文（message）と本質が無い＝「ブレインを根拠に挙げた指摘」の道は引用に Brain の語がある時だけ数える（少なめに出る・② が文と本質ありの数）
      const bb = !anch && brainBacksIssue({ code: i.code, severity: i.severity, evidence: ev, message: "" } as AlignIssue, null, cq);
      const newP = anch || bb;
      const cls = oldP ? "旧でも渡る（渡したのに残った）" : anch ? "新で渡る（引用の断片が本文）" : bb ? "新で渡る（ブレインの質問が裏付け）" : "渡らない（引用が本文に無く裏付けなし）";
      byCls.set(cls, (byCls.get(cls) ?? 0) + 1);
      const c = byCode.get(i.code) ?? { n: 0, oldPass: 0, newPass: 0, bb: 0 }; c.n++; if (oldP) c.oldPass++; if (newP) c.newPass++; if (bb) c.bb++; byCode.set(i.code, c);
      if (oldP) turnsOldPassable.add(t.id);
      if (!newP && HELD && heldSamples.length < 60) heldSamples.push(`  ${String(t.conversation_id).slice(0, 8)} [${i.code}/${i.pass}] 引用「${ev.slice(0, 90)}」 質問:${cq.length}`);
      if (newP && !oldP) { turnsNewFixable.add(t.id); if (samples.length < 12) samples.push(`  ${String(t.conversation_id).slice(0, 8)} ${String(t.customer_turn_at).slice(0, 10)} [${i.code}] 引用「${ev.slice(0, 70)}」${bb ? `（質問: ${cq.join(" / ").slice(0, 60)}）` : ""}`); }
    }
  }
  console.log(`■① 最終チェックが掛かった番 ${turns.length}・画面に指摘（事実・安全・取りこぼし）が残った番 ${withShown}（${pct(withShown, turns.length)}）・指摘 ${nIssues}`);
  for (const [k, n] of [...byCls].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${String(n).padStart(4)}（${pct(n, nIssues)}）`);
  console.log(`  旧では書き直しに渡らず、新で渡る指摘がある番: ${turnsNewFixable.size}（残った番の ${pct(turnsNewFixable.size, withShown)}）`);
  console.log("  code ごと（件数・旧で渡る・新で渡る・うちブレインの質問の裏付け）:");
  for (const [k, v] of [...byCode].sort((a, b) => b[1].n - a[1].n).slice(0, 18)) console.log(`    ${k.padEnd(28)} ${String(v.n).padStart(3)}  旧 ${v.oldPass}  新 ${v.newPass}  裏付け ${v.bb}`);
  if (DETAIL) { console.log("  新で渡るようになる見本:"); for (const s of samples) console.log(s); }
  if (HELD) { console.log("  渡らないまま（引用が本文に無く裏付けなし）:"); for (const s of heldSamples) console.log(s); }

  // ── ② 会話ごとの最新（指摘の文あり）× ブレインの本質 ──
  const convs = (await page("conversations", "id, updated_at, ai_draft_check, last_brain_meta", (q) => q.not("ai_draft_check", "is", null).gte("updated_at", SINCE)))
    .filter((c) => !TEST_IDS.has(c.id));
  let cN = 0, cIss = 0, contra = 0, bbacked = 0, anchoredNew = 0, oldPass = 0, cHeld = 0;
  const contraCodes = new Map<string, number>();
  for (const c of convs) {
    const iss = ((c.ai_draft_check?.issues ?? []) as Row[]).filter(shownIssue);
    if (!iss.length) continue;
    cN++;
    const bm = c.last_brain_meta ?? {};
    const contract = bm.turn_contract ? buildTurnContract({ brain: bm.turn_contract, brainFresh: true, ledgerItems: [], alreadySaid: [], settled: [] }) : null;
    // 下書きは同じ会話の最後の番の draft_last（無ければ書き直しの文・下書きの頭）
    const lastTurn = turns.filter((t) => t.conversation_id === c.id).sort((a, b) => String(b.customer_turn_at).localeCompare(String(a.customer_turn_at)))[0];
    const draft = String(lastTurn?.draft_last ?? c.ai_draft_check?.revised_text ?? c.ai_draft_check?.tpo_debug?.draftHead ?? "");
    for (const i of iss) {
      cIss++;
      const ai: AlignIssue = { code: i.code, severity: i.severity, message: i.message, evidence: i.evidence, suggestion: i.suggestion };
      if (contract && issueContradictsContract(ai, contract)) { contra++; contraCodes.set(i.code, (contraCodes.get(i.code) ?? 0) + 1); continue; }
      const anch = draft ? evidenceAnchoredInDraft(i.evidence, draft) : false;
      const bb = brainBacksIssue(ai, contract, bm.customer_questions ?? null);
      if (draft && legacyAnchored(String(i.evidence ?? ""), draft)) oldPass++;
      if (anch) anchoredNew++; else if (bb) bbacked++; else cHeld++;
    }
  }
  console.log(`\n■② 会話ごとの最新の指摘（文あり）: 会話 ${cN}・指摘 ${cIss}（本質は last_brain_meta＝近似）`);
  console.log(`  ブレインの本質とぶつかる（新では書き直さず画面からも外す）: ${contra}  ${[...contraCodes].map(([k, n]) => `${k} ${n}`).join(" / ")}`);
  console.log(`  ブレインの本質・質問が裏付ける取りこぼし（新で書き直しに渡る）: ${bbacked}`);
  console.log(`  引用の断片が下書きにある（下書きの頭が残る物だけ）: ${anchoredNew}（うち旧でも渡る ${oldPass}）`);
  console.log(`  どちらでもない（理由を付けて画面に残す）: ${cHeld}`);

  // ── ③ 書き直しを採らなかった理由 ──
  const drop = new Map<string, number>(); let gate = 0;
  for (const e of ex) {
    if (TEST_IDS.has(e.conversation_id)) continue;
    const g = e.reply_context_snapshot?.finalCheckGate; if (!g) continue; gate++;
    const k = g.revisionDropped ?? (g.revisionSkipped ? `skip:${g.revisionSkipped}` : g.draftIn ? "revised" : "(なし)");
    drop.set(k, (drop.get(k) ?? 0) + 1);
  }
  console.log(`\n■③ 送った例の書き直しの道（finalCheckGate あり ${gate}）: ${[...drop].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" / ")}`);
  // 10/13 から（ブレイン基準の直しの後）: 渡さなかった理由・ブレインの裏付け・画面から外した指摘
  const held = new Map<string, number>(); let bb = 0, ov = 0; const ovCode = new Map<string, number>();
  for (const e of ex) {
    const g = e.reply_context_snapshot?.finalCheckGate; if (!g || TEST_IDS.has(e.conversation_id)) continue;
    for (const x of g.revisionHeld ?? []) { const r = String(x).split(":")[1] ?? "?"; held.set(r, (held.get(r) ?? 0) + 1); }
    bb += (g.brainBacked ?? []).length; ov += (g.brainOverruled ?? []).length;
    for (const c of g.brainOverruled ?? []) ovCode.set(String(c), (ovCode.get(String(c)) ?? 0) + 1);
  }
  console.log(`  （10/13〜）渡さなかった指摘の理由: ${[...held].map(([k, n]) => `${k} ${n}`).join(" / ") || "記録なし"}・ブレインの裏付けで渡した ${bb}・ブレインと逆で画面から外した ${ov}`);
  // 10/13 レビュー（軽微3・見張り）: 画面から外した warning の code ごと（AIX_BOUNDARY_ESTIMATE/VIEWING が多ければ見直す。block は外さないので安全の線は残る）
  console.log(`  画面から外した warning の code: ${[...ovCode].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" / ") || "記録なし"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
