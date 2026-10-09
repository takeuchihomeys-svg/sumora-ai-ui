// 下書きの「まとまり」の監査（読み取りだけ・LLM なし）— 2026-10-09 竹内「単語をつなげただけのような部分がたまにある」
//
// 量る物:
//   ① 継ぎ目の型（app/lib/draft-coherence.ts）の率: AI の下書き vs 人の実送信（人の文での率＝誤検知の目安）
//   ② 出所の手掛かり別の率: 出口のゲートが文を消した・置き換えた（tpo_debug.postprocess.gateEdits）／最終チェックの書き直しの指摘があった（preRevisionCodes）／
//      決定論の差し込みの文（初期費用の一文・募集状況のご連絡の約束・ポータルの説明・全力サポートの代わりの締め）が入っている
//   ③ 継ぎ目のある下書きは実送信から遠いか（messageSimilarity・竹内さんの送信だけでも）・スタッフが継ぎ目を消したか
//   ④ 型ごとの実例（伏せて各3件）
//   ⑤ conversations.ai_draft_check.pre_revision_text（10/09〜）がある行: 書き直しの前と後で継ぎ目が増えたか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-coherence.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { findSeams, type SeamKind } from "../app/lib/draft-coherence";
import { messageSimilarity } from "../app/lib/phrase-shape";
import { writerFromText } from "../app/lib/staff-writer";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ?? "");
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 30);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s
  .replace(/[^\s、。！!？?「」]{1,10}(?:さん|様|さま)/g, "〈名〉")
  .replace(/\d{2,4}-?\d{3,4}-?\d{3,4}/g, "〈番号〉")
  .replace(/\n/g, " ／ ");
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const INSERT_MARKS: Array<[string, RegExp]> = [
  ["初期費用の一文", /最大限割引させて頂き[^！\n]{0,20}費用を出来る限り抑えさせて頂きます/],
  ["募集状況のご連絡の約束", /その時点の募集状況をご連絡/],
  ["ポータルの説明", /オトリ|おとり広告/],
  ["全力サポートの代わりの締め", /^引き続き何卒/m],
];

type Row = { id: string; conversation_id: string | null; ai_draft: string; sent_reply: string; was_ai_used: boolean | null; created_at: string; reply_context_snapshot: Record<string, unknown> | null };

async function load(): Promise<Row[]> {
  const out: Row[] = [];
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, ai_draft, sent_reply, was_ai_used, created_at, reply_context_snapshot")
      .eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null)
      .order("created_at", { ascending: false }).range(p * 500, p * 500 + 499);
    if (error) { console.log("⚠", error.message); break; }
    out.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 500) break;
  }
  return out.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim());
}

async function main() {
  const rows = await load();
  console.log(`=== 材料: 返信の下書きと実送信が揃う ${rows.length}組（直近${days}日・line_reply）===\n`);
  const kinds: SeamKind[] = ["FRAGMENT_HEAD", "DANGLING_TAIL", "DUP_SENTENCE", "DOUBLE_CLOSE", "PUNCT_JUNK", "PARTICLE_STOP"];
  const draftK = new Map<SeamKind, number>(), sentK = new Map<SeamKind, number>(), removedK = new Map<SeamKind, number>();
  const examples = new Map<SeamKind, string[]>();
  let draftAny = 0, sentAny = 0;
  const simSeam: number[] = [], simClean: number[] = [], simSeamA: number[] = [], simCleanA: number[] = [];
  let usedSeam = 0, usedClean = 0, nSeam = 0, nClean = 0;
  const byCause = new Map<string, { n: number; seam: number }>();
  const bump = (k: string, seam: boolean) => { const v = byCause.get(k) ?? { n: 0, seam: 0 }; v.n++; if (seam) v.seam++; byCause.set(k, v); };

  for (const r of rows) {
    const d = r.ai_draft, s = r.sent_reply;
    const ds = findSeams(d), ss = findSeams(s);
    const dk = new Set(ds.map((x) => x.kind)), sk = new Set(ss.map((x) => x.kind));
    if (dk.size) draftAny++;
    if (sk.size) sentAny++;
    for (const k of dk) {
      draftK.set(k, (draftK.get(k) ?? 0) + 1);
      if (!sk.has(k)) removedK.set(k, (removedK.get(k) ?? 0) + 1);
      const ex = examples.get(k) ?? [];
      if (ex.length < 3) { const e = ds.find((x) => x.kind === k)!; ex.push(`${r.created_at.slice(0, 10)} ${r.id.slice(0, 8)} 「${mask(e.evidence)}」\n        下書き: ${mask(d).slice(0, 220)}\n        実送信: ${mask(s).slice(0, 160)}`); examples.set(k, ex); }
    }
    for (const k of sk) sentK.set(k, (sentK.get(k) ?? 0) + 1);
    const sim = messageSimilarity(d, s);
    const isA = writerFromText(s).writer === "takeuchi";
    if (dk.size) { simSeam.push(sim); nSeam++; if (r.was_ai_used) usedSeam++; if (isA) simSeamA.push(sim); }
    else { simClean.push(sim); nClean++; if (r.was_ai_used) usedClean++; if (isA) simCleanA.push(sim); }

    const snap = (r.reply_context_snapshot ?? {}) as Record<string, any>;
    const gateEdits = Array.isArray(snap.postprocess?.gateEdits) ? snap.postprocess.gateEdits : [];
    const pre = Array.isArray(snap.preRevisionCodes) ? snap.preRevisionCodes : [];
    const seam = dk.size > 0;
    bump("全体", seam);
    bump(gateEdits.length ? "出口のゲートが消した・置き換えた" : "出口のゲート無し", seam);
    for (const g of gateEdits) bump(`  ゲート ${g.rule}${g.after == null ? "（削除）" : "（置換）"}`, seam);
    bump(pre.length ? "最終チェックの指摘あり（書き直しの対象）" : "最終チェックの指摘なし", seam);
    if (snap.revisionOutcome) bump(`  最終チェック ${snap.revisionOutcome}`, seam);
    let anyIns = false;
    for (const [k, re] of INSERT_MARKS) if (re.test(d) && !re.test(s)) { bump(`差し込み ${k}（実送信では消えた）`, seam); anyIns = true; }
    for (const [k, re] of INSERT_MARKS) if (re.test(d) && re.test(s)) bump(`差し込み ${k}（実送信にも残る）`, seam);
    if (!anyIns && !gateEdits.length && !pre.length) bump("手掛かりなし（生成そのまま に近い）", seam);
  }

  console.log(`=== ① 継ぎ目の率（組ごと・型が1つでもあれば）===`);
  console.log(`   AI の下書き ${pct(draftAny, rows.length)}（${draftAny}/${rows.length}）  人の実送信 ${pct(sentAny, rows.length)}（${sentAny}）`);
  console.log(`   型            下書き      実送信     下書きにあり実送信で消えた`);
  for (const k of kinds) console.log(`   ${k.padEnd(14)} ${String(draftK.get(k) ?? 0).padStart(4)} ${pct(draftK.get(k) ?? 0, rows.length).padStart(6)}  ${String(sentK.get(k) ?? 0).padStart(4)} ${pct(sentK.get(k) ?? 0, rows.length).padStart(6)}   ${removedK.get(k) ?? 0}/${draftK.get(k) ?? 0}`);

  console.log(`\n=== ② 出所の手掛かり別（その組の下書きに継ぎ目がある率）===`);
  for (const [k, v] of [...byCause.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`   ${pct(v.seam, v.n).padStart(6)}  (${v.seam}/${v.n})  ${k}`);

  console.log(`\n=== ③ 継ぎ目と実送信への近さ ===`);
  console.log(`   継ぎ目あり ${nSeam}組: 近さの中央値 ${med(simSeam).toFixed(3)}・そのまま送った ${pct(usedSeam, nSeam)}  ／ 竹内さんの送信だけ ${simSeamA.length}組 ${med(simSeamA).toFixed(3)}`);
  console.log(`   継ぎ目なし ${nClean}組: 近さの中央値 ${med(simClean).toFixed(3)}・そのまま送った ${pct(usedClean, nClean)}  ／ 竹内さんの送信だけ ${simCleanA.length}組 ${med(simCleanA).toFixed(3)}`);

  console.log(`\n=== ④ 型ごとの実例（伏せて各3件）===`);
  for (const k of kinds) { console.log(`  ■ ${k}`); for (const e of examples.get(k) ?? []) console.log(`    - ${e}`); }

  // ⑤ 書き直しの前と後（10/09 から残る pre_revision_text）
  const { data: convs } = await sb.from("conversations").select("id, ai_draft, ai_draft_check").not("ai_draft_check->>pre_revision_text", "is", null).limit(500);
  let n5 = 0, before5 = 0, after5 = 0;
  const ex5: string[] = [];
  for (const c of (convs ?? []) as Array<{ id: string; ai_draft: string | null; ai_draft_check: Record<string, any> | null }>) {
    const pre = String(c.ai_draft_check?.pre_revision_text ?? ""); const post = String(c.ai_draft_check?.revised_text ?? c.ai_draft ?? "");
    if (!pre || !post || post === "__SHOWN__") continue;
    n5++; const b = findSeams(pre).length, a = findSeams(post).length;
    if (b) before5++; if (a) after5++;
    if (ex5.length < 3) ex5.push(`前: ${mask(pre).slice(0, 160)}\n        後: ${mask(post).slice(0, 160)}`);
  }
  console.log(`\n=== ⑤ 最終チェックの書き直しの前と後（pre_revision_text のある会話 ${n5}件）: 継ぎ目 前 ${before5} → 後 ${after5} ===`);
  for (const e of ex5) console.log(`    - ${e}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
