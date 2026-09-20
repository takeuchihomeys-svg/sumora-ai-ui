// 2通目（AIXテンプレート）はお客様の返信を引き出しているか（読み取りのみ）
//
// 2026-09-20 竹内「長さで文を切るのではなくて質を上げるイメージ。
//   **AIX の文が長いので、そこで終わったら返信帰ってきにくい。
//   AIX テンプレートは要点絞ってるから返信しやすいお客さんが**」
//
// ＝ 2通目の役割は「返信を引き出すこと」。長さは結果であって目的ではない。
//    だから質は**返信率**で測る。
//
// ⚠ 設計知見「物件選定の正解は“スタッフが選んで送った事実”で、顧客の返信有無は補助シグナル」は
//   **物件選定のラベル**の話。ここは「返信しやすい文か」が目的そのものなので返信率で測ってよい。
//
// 測ること:
//   ① AIX の1通目だけで終わった時 vs 2通目も送った時 の返信率（竹内さんの仮説の検証）
//   ② 2通目の**どんな形**が返信を引き出しているか（長さ帯・疑問形・依頼形・次の一歩）
//   ③ 返信が来た2通目と来なかった2通目を並べて読む
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const REPLY_WINDOW_H = Number(process.env.REPLY_WINDOW_H ?? 72);

async function page(table: string, select: string, order: string, days: number, extra?: (q: any) => any): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 16; p++) {
    let q: any = sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

async function main() {
  const days = Number(process.env.DAYS ?? 120);

  const logs = await page("aix_usage_logs", "conversation_id, aix_type, sent_at, created_at", "created_at", days);
  const convIds = [...new Set(logs.map((l) => String(l.conversation_id ?? "")).filter(Boolean))];

  // その会話の全メッセージ（スタッフ・お客様の両方）
  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    const chunk = convIds.slice(i, i + 20);
    for (let p = 0; p < 12; p++) {
      const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
        .in("conversation_id", chunk)
        .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
        .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as typeof msgs;
      if (r.length === 0) break;
      msgs.push(...r);
      if (r.length < 1000) break;
    }
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  for (const [, l] of byConv) l.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  // ── AIX 送信ごとに「1通目・2通目・その後の返信」を組む ──
  type Case = { aix: string; first: string; second: string | null; replied: boolean; replyMin: number | null };
  const cases: Case[] = [];
  for (const l of logs) {
    const c = String(l.conversation_id ?? "");
    const t = Date.parse(String(l.sent_at ?? l.created_at));
    if (!c || Number.isNaN(t)) continue;
    const list = byConv.get(c) ?? [];
    const staff = list.filter((m) => m.sender === "staff" && (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    const first = staff.find((m) => Math.abs(Date.parse(m.created_at) - t) <= 5 * 60_000);
    if (!first) continue;
    const ft = Date.parse(first.created_at);
    // 2通目 = 1通目の後30分以内のスタッフ送信
    const second = staff.find((m) => Date.parse(m.created_at) > ft && Date.parse(m.created_at) <= ft + 30 * 60_000) ?? null;
    // 最後のスタッフ送信の時刻（ここを起点に返信を数える＝2通目の有無で起点が動く）
    const lastStaffAt = second ? Date.parse(second.created_at) : ft;
    // その後 REPLY_WINDOW_H 以内のお客様の発言
    const reply = list.find((m) => m.sender === "customer" && Date.parse(m.created_at) > lastStaffAt
      && Date.parse(m.created_at) <= lastStaffAt + REPLY_WINDOW_H * 3600_000 && (m.text ?? "").trim().length > 0);
    // 窓が閉じきっていない（送信が最近すぎる）ものは除く＝「まだ返信が来ていないだけ」を混ぜない
    if (Date.now() - lastStaffAt < REPLY_WINDOW_H * 3600_000) continue;
    cases.push({
      aix: String(l.aix_type ?? "?"),
      first: String(first.text),
      second: second ? String(second.text) : null,
      replied: !!reply,
      replyMin: reply ? Math.round((Date.parse(reply.created_at) - lastStaffAt) / 60_000) : null,
    });
  }

  const only1 = cases.filter((c) => !c.second);
  const with2 = cases.filter((c) => !!c.second);
  console.log(`=== ① 1通目だけ vs 2通目あり の返信率（${REPLY_WINDOW_H}時間以内・直近${days}日）===`);
  console.log(`   対象 ${cases.length}件（窓が閉じたものだけ）\n`);
  console.log(`   1通目だけで終わった : ${String(only1.length).padStart(4)}件 → 返信あり ${String(only1.filter((c) => c.replied).length).padStart(4)}件 (${pct(only1.filter((c) => c.replied).length, only1.length)})`);
  console.log(`   2通目も送った       : ${String(with2.length).padStart(4)}件 → 返信あり ${String(with2.filter((c) => c.replied).length).padStart(4)}件 (${pct(with2.filter((c) => c.replied).length, with2.length)})`);
  console.log(`   → 竹内「AIX の文が長いのでそこで終わったら返信帰ってきにくい」の検証`);

  // AIX 種類別
  console.log(`\n   --- AIX 種類別（1通目だけ → 2通目あり の返信率）---`);
  const types = [...new Set(cases.map((c) => c.aix))];
  for (const ty of types) {
    const a = only1.filter((c) => c.aix === ty), b = with2.filter((c) => c.aix === ty);
    if (a.length + b.length < 20) continue;
    console.log(`     ${ty.padEnd(28)} 1通目だけ ${String(a.filter((c) => c.replied).length).padStart(3)}/${String(a.length).padStart(3)} (${pct(a.filter((c) => c.replied).length, a.length).padStart(6)})   2通目あり ${String(b.filter((c) => c.replied).length).padStart(3)}/${String(b.length).padStart(3)} (${pct(b.filter((c) => c.replied).length, b.length).padStart(6)})`);
  }

  if (with2.length === 0) { console.log("\n   2通目のある件が無い"); return; }

  // ── ② 2通目の「形」ごとの返信率 ──
  console.log(`\n=== ② 2通目のどんな形が返信を引き出しているか（${with2.length}件）===`);
  const FORMS: Array<[string, (s: string) => boolean]> = [
    ["疑問形で終わる（？で終わる）", (s) => /[?？][！!😊😌\s]*$/.test(s.trim())],
    ["疑問形を含む", (s) => /[?？]|でしょうか|ますか|いかがで/.test(s)],
    ["お申し付けください", (s) => /お申し付け/.test(s)],
    ["お気軽に", (s) => /お気軽/.test(s)],
    ["お気に召されましたら", (s) => /お気に召され/.test(s)],
    ["内覧の誘導", (s) => /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます|ご内覧/.test(s)],
    ["申込の誘導", (s) => /お?申(?:し)?込/.test(s)],
    ["物件名・号室を書く", (s) => /[0-9０-９]{2,4}号室|🌟/.test(s)],
    ["箇条書き（・で始まる行が2行以上）", (s) => (s.match(/^[・･]/gm) ?? []).length >= 2],
    ["ご査収", (s) => /ご査収/.test(s)],
    ["何卒よろしく", (s) => /何卒/.test(s)],
    ["全力でサポート", (s) => /全力でサポート/.test(s)],
  ];
  console.log(`   ${"形".padEnd(34)} 件数   返信あり`);
  for (const [label, fn] of FORMS) {
    const g = with2.filter((c) => fn(c.second!));
    if (g.length < 5) continue;
    const r = g.filter((c) => c.replied).length;
    const base = with2.filter((c) => c.replied).length / with2.length;
    const diff = g.length ? (r / g.length) - base : 0;
    const mark = Math.abs(diff) >= 0.05 ? (diff > 0 ? "  ↑" : "  ↓") : "";
    console.log(`   ${label.padEnd(34)} ${String(g.length).padStart(4)}件  ${String(r).padStart(4)}件 (${pct(r, g.length).padStart(6)})${mark}`);
  }
  console.log(`   ※ ↑↓ は全体の返信率から5ポイント以上ずれている形`);

  // 長さ帯別
  console.log(`\n   --- 2通目の長さ帯別の返信率 ---`);
  for (const [lo, hi] of [[0, 60], [60, 100], [100, 140], [140, 180], [180, 240], [240, 100000]] as Array<[number, number]>) {
    const g = with2.filter((c) => c.second!.length >= lo && c.second!.length < hi);
    if (g.length < 5) continue;
    const r = g.filter((c) => c.replied).length;
    const bar = "█".repeat(Math.round((r / g.length) * 30));
    console.log(`     ${String(lo).padStart(3)}〜${hi === 100000 ? "   " : String(hi).padStart(3)}字  ${String(g.length).padStart(4)}件  返信 ${pct(r, g.length).padStart(6)} ${bar}`);
  }

  // 1通目の長さ帯別（竹内「AIX の文が長いので返信帰ってきにくい」）
  console.log(`\n   --- 1通目（AIX）の長さ帯別の返信率（2通目なしの件だけ）---`);
  for (const [lo, hi] of [[0, 100], [100, 200], [200, 300], [300, 500], [500, 100000]] as Array<[number, number]>) {
    const g = only1.filter((c) => c.first.length >= lo && c.first.length < hi);
    if (g.length < 5) continue;
    const r = g.filter((c) => c.replied).length;
    const bar = "█".repeat(Math.round((r / g.length) * 30));
    console.log(`     ${String(lo).padStart(3)}〜${hi === 100000 ? "   " : String(hi).padStart(3)}字  ${String(g.length).padStart(4)}件  返信 ${pct(r, g.length).padStart(6)} ${bar}`);
  }

  // ── ③ 実物（返信が来た2通目・来なかった2通目）──
  const replied = with2.filter((c) => c.replied);
  const notReplied = with2.filter((c) => !c.replied);
  console.log(`\n=== ③ 実物 ===`);
  console.log(`\n   --- 返信が来た2通目（6件）---`);
  for (const c of replied.slice(0, 6)) console.log(`     [${c.aix}] ${c.replyMin}分後に返信 (${c.second!.length}字)\n       ${c.second!.replace(/\n/g, " ／ ").slice(0, 120)}`);
  console.log(`\n   --- 返信が来なかった2通目（6件）---`);
  for (const c of notReplied.slice(0, 6)) console.log(`     [${c.aix}] (${c.second!.length}字)\n       ${c.second!.replace(/\n/g, " ／ ").slice(0, 120)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
