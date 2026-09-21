// 「申込が実際に済んだか」を会話から決められるか（読み取りのみ）
//
// 2026-09-21 竹内「先ほどの実際に申し込んだかのところ判断できるようにする」
//
// ■ 今の状態
//   LedgerFacts には `applicationGuided`（AIX【申込へ】を押した＝**案内した**）はあるが、
//   「**実際に申し込んだか**」を表す項目が無い。
//   ＝ 材料に「申込は済んでいない」が無いので、LLM が想像で埋める余地がある
//     （設計知見「材料が空の時ほど LLM は会話から拾って埋める」）。
//
// ■ ここで測ること
//   スタッフの実送信から「申込に進んだ」ことを表す形を集め、
//   ①どの言い回しが使われているか ②段階（これから／進行中／完了／審査中）に分けられるか
//   ③その形が「申込していない会話」に出ていないか（誤判定0の線）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-application-submitted.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 365);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** 段階ごとの言い回しの候補（実送信を読んで作る） */
const STAGES: Array<[string, RegExp]> = [
  ["① これから申し込む（宣言）", /お?申込(?:み|し|)(?:させて(?:頂|いただ)きます|します|いたします)|お申込み手続き(?:を)?進め/],
  ["② 申込の情報を依頼", /お申込(?:み|)に(?:必要|あたり)|申込書|緊急連絡先|勤務先(?:を|の)?(?:お|ご)?(?:教え|記入|ご記入)/],
  ["③ 申込完了・確認中", /お?申込(?:み|)(?:完了|入れ(?:させて|ました)|入っており)|1番手で(?:の)?お?申込|一番手で(?:の)?お?申込|お部屋(?:を)?(?:抑え|押さえ)(?:させて(?:頂|いただ)きました|ました)/],
  ["④ 審査", /審査(?:中|に進|結果|通過|否決|開始)/],
];

async function page(table: string, select: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const msgs = (await page("messages", "conversation_id, sender, text, created_at", DAYS))
    .filter((m) => String(m.sender) === "staff" && String(m.text ?? "").trim());
  console.log(`=== 直近${DAYS}日 スタッフ送信 ${msgs.length}通 ===\n`);

  console.log(`=== ① 段階ごとの言い回しが何通あるか ===`);
  for (const [label, re] of STAGES) {
    const hit = msgs.filter((m) => re.test(String(m.text)));
    console.log(`   ${label.padEnd(24)} ${String(hit.length).padStart(5)}通（${pct(hit.length, msgs.length)}）`);
  }

  console.log(`\n=== ② 会話ごとに「申込に進んだ」と言えるか ===`);
  const byConv = new Map<string, Array<{ text: string; at: number }>>();
  for (const m of msgs) {
    const c = String(m.conversation_id ?? "");
    const at = Date.parse(String(m.created_at ?? ""));
    if (!c || Number.isNaN(at)) continue;
    byConv.set(c, [...(byConv.get(c) ?? []), { text: String(m.text), at }]);
  }
  const SUBMITTED_RE = new RegExp([STAGES[0][1].source, STAGES[2][1].source].join("|"));
  let convSubmitted = 0;
  for (const list of byConv.values()) {
    if (list.some((x) => SUBMITTED_RE.test(x.text))) convSubmitted++;
  }
  console.log(`   会話 ${byConv.size}件 ／ 申込に進んだ形がある会話 **${convSubmitted}件（${pct(convSubmitted, byConv.size)}）**`);

  // ③ status=applying の会話と突き合わせる（判定が合っているか）
  const convs: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from("conversations").select("id, status").range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<Record<string, unknown>>;
    if (r.length === 0) break; convs.push(...r); if (r.length < 1000) break;
  }
  const statusById = new Map(convs.map((c) => [String(c.id), String(c.status ?? "")]));
  const APPLYING_STATUSES = new Set(["applying", "screening", "contract", "closed_won", "成約", "申込", "審査中"]);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const [cid, list] of byConv.entries()) {
    const detected = list.some((x) => SUBMITTED_RE.test(x.text));
    const st = statusById.get(cid) ?? "";
    const actual = APPLYING_STATUSES.has(st);
    if (detected && actual) tp++;
    else if (detected && !actual) fp++;
    else if (!detected && actual) fn++;
    else tn++;
  }
  console.log(`\n=== ③ status（applying 以降）と突き合わせ ===`);
  console.log(`   両方あり（合っている）        ${tp}件`);
  console.log(`   文はあるが status は前段階    ${fp}件  ← 申込を宣言したが status が追いついていない／立ち消え`);
  console.log(`   status は先だが文が無い        ${fn}件  ← 言い回しの取りこぼし`);
  console.log(`   両方なし                      ${tn}件`);
  console.log(`   ※ status は人が変える物なので完全一致はしない。文の側の**取りこぼし（fn）**が少ないかを見る`);

  console.log(`\n=== ④ 段階ごとの実物（言い回しを目で読む）===`);
  for (const [label, re] of STAGES) {
    const hit = msgs.filter((m) => re.test(String(m.text)));
    console.log(`\n   ─ ${label} ─`);
    const lines = new Map<string, number>();
    for (const m of hit) {
      for (const l of String(m.text).split("\n")) {
        if (re.test(l)) {
          const k = mask(l.trim()).replace(/[^\s]{2,24}\s*\d{1,4}号室/g, "〈物件〉").slice(0, 52);
          if (k.length >= 8) lines.set(k, (lines.get(k) ?? 0) + 1);
        }
      }
    }
    for (const [l, n] of [...lines.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`     ${String(n).padStart(3)}回  ${l}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
