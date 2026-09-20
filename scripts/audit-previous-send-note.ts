// 直前送信から作る材料（previous-send-note）を実送信の全件に当てて、目で読む（読み取りのみ）
//
// 2026-09-21 竹内「生成した文は送った内容と同じ内容を再度送っていた形となるので、これを防ぐ」
//
// 設計知見「全件監査（過去の実送信・下書きに当てて、変換の前後を**目で読む**。件数だけ見ない）」。
//   この関数は**本文を書き換えない**（LLM に渡す材料を作るだけ）ので、危ないのは
//   「間違った具体を名指ししてしまう」こと（例: 費用の行を物件名として渡す）。
//   → 拾った物件名・日程・時刻を全部並べて、おかしい物が無いかを見る。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-previous-send-note.ts
import { createClient } from "@supabase/supabase-js";
import { buildPreviousSendNote, extractClosingClauses, extractConcreteFacts } from "../app/lib/previous-send-note";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number | null) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");
/** 物件名として明らかにおかしい形（目で見る前の当たり） */
const SUSPECT_RE = /^[0-9\s\/:：月日年\-]+$|^(?:お|ご|はい|かしこ|何卒|お手隙)|[0-9]{3,}円|初期費用|割引|節約|徒歩|万円/;

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const msgs = await page("messages", "conversation_id, sender, text, created_at", "created_at", days);
  const staff = msgs.filter((m) => String(m.sender) === "staff").map((m) => String(m.text ?? "").trim()).filter(Boolean);
  console.log(`=== 材料: スタッフ実送信 ${staff.length}通（直近${days}日）===\n`);

  let withNote = 0, withClosing = 0, withFacts = 0;
  const nameCount = new Map<string, number>();
  const suspects: Array<{ name: string; src: string }> = [];
  const dateCount = new Map<string, number>();

  for (const t of staff) {
    const note = buildPreviousSendNote(t);
    if (note) withNote++;
    const cl = extractClosingClauses(t); if (cl.length) withClosing++;
    const fa = extractConcreteFacts(t); if (fa.length) withFacts++;
    for (const f of fa) {
      if (f.kind === "物件名") {
        nameCount.set(f.value, (nameCount.get(f.value) ?? 0) + 1);
        if (SUSPECT_RE.test(f.value) && suspects.length < 40) suspects.push({ name: f.value, src: mask(t).slice(0, 110) });
      }
      if (f.kind === "日程") dateCount.set(f.value, (dateCount.get(f.value) ?? 0) + 1);
    }
  }

  console.log(`=== ① どれくらいの送信に材料が付くか ===`);
  console.log(`   材料が付く   ${withNote}通 (${(withNote / staff.length * 100).toFixed(1)}%)`);
  console.log(`   締めを拾えた ${withClosing}通 (${(withClosing / staff.length * 100).toFixed(1)}%)`);
  console.log(`   具体を拾えた ${withFacts}通 (${(withFacts / staff.length * 100).toFixed(1)}%)`);

  console.log(`\n=== ② 物件名として拾った物のうち「おかしい形」（0件が目標）===`);
  console.log(`   おかしい形 ${suspects.length}件`);
  for (const s of suspects.slice(0, 25)) console.log(`     「${s.name}」 ← ${s.src}`);

  console.log(`\n=== ③ 拾った物件名の上位20（実在する物件名に見えるか目で読む）===`);
  for (const [n, c] of [...nameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`   ${String(c).padStart(4)}件  ${n}`);
  }

  console.log(`\n=== ④ 拾った日程の上位15 ===`);
  for (const [n, c] of [...dateCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   ${String(c).padStart(4)}件  ${n}`);
  }

  console.log(`\n=== ⑤ 出来上がった材料の実物（10通・変換の前後を目で読む）===`);
  let shown = 0;
  for (const t of staff) {
    if (shown >= 10) break;
    const note = buildPreviousSendNote(t);
    if (!note) continue;
    if (shown % 2 === 0 && extractConcreteFacts(t).length === 0) continue; // 具体あり／なしを混ぜる
    shown++;
    console.log(`${"─".repeat(78)}`);
    console.log(`   直前送信: ${mask(t).slice(0, 150)}`);
    console.log(`   材料    : ${mask(note.trim())}`);  // 材料にもお客様の呼びかけが入るのでマスクする
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
