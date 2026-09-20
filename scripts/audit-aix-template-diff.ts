// AIX テンプレート（AIX を送った後に選ぶテンプレ）の生成文と実送信の差分（読み取りのみ）
//
// 2026-09-20 竹内「AIX で送ったあとの AIX テンプレートの文の質を上げるために、
//   実際に送った文と生成された文の違いからテストまわして、問題があるか原因を調査する」
//
// 設計知見（先に引いたもの）:
//   ・「生成した文を残していない経路は、学習も原因追跡もできない」
//     → aix-template-generate は生成文を1行も残していなかった。aix_generate_log に status="generated" で
//       記録するようにした（既存の used/discarded 集計を汚さない値）。**まず記録が溜まっているかを見る**。
//   ・「生成文と実送信の差分が正解データ」
//   ・「入口だけ直しても生成後の癖は残る — 出口の決定論も同じ関数で全経路に配る」
//     → stripWaited 等がテンプレートに配られていなかった事例がある。同じ形の漏れが他にないかを差分から探す。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number | null, filter?: (q: ReturnType<typeof sb.from>) => unknown): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 12; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    if (filter) q = filter(q as never) as typeof q;
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

/** 生成文と実送信の「違い」の種類（実物を読んで足していく） */
const DIFFS: Array<{ key: string; re: RegExp; note: string }> = [
  { key: "お待たせ致しました（禁止語）", re: /お待たせ(?:致|いた)?しました/, note: "greeting.ts で全廃済み。出口 stripWaited が配られているか" },
  { key: "重複しないよう選定（やった風）", re: /重複(?:し)?ない|被らない|かぶらない|重ならない|選定(?:し|致)/, note: "システムが確かめていない主張。stripUnfoundedSelectionClaim" },
  { key: "曖昧な数量（数件・いくつか）", re: /数件|いくつか|複数件|何件か/, note: "stripVagueQuantifier" },
  { key: "全力でサポート", re: /全力でサポート/, note: "場面によっては実送信ほぼ0%" },
  { key: "何卒よろしくお願い", re: /何卒(?:よろしく|宜しく)お願い/, note: "" },
  { key: "ご査収", re: /ご査収/, note: "物件送付の標準の締め" },
  { key: "お気軽にご連絡", re: /いつでもお気軽|何時でもお気軽|お気軽にご連絡/, note: "" },
  { key: "比較フレーム（お送りした中でも）", re: /お送り(?:させて(?:頂|いただ)き)?(?:ました)?(?:お部屋|物件)の中でも/, note: "2件以上送った時だけ（実送信 1件以下は0件）" },
  { key: "埋まってしまう（煽り）", re: /埋まって(?:しまい|しまう)|残り\s*[0-9０-９]\s*(?:部屋|室)/, note: "application_push の forbid" },
  { key: "候補日時を聞く疑問形", re: /ご都合[^\n]{0,12}(?:お日にち|日程)[^\n]{0,12}(?:御座|ござ)いますでしょうか/, note: "AIX【内覧日調整】の担当" },
  { key: "作業メモ・AIの独り言", re: /出力(?:は|を)?行(?:い|え)ま?せん|以下(?:は|の)[^\n]{0,20}(?:返信文|文章)です|として出力|入力内容が存在しない/, note: "isNotACustomerReply" },
  { key: "金額を本文に書く", re: /[0-9０-９]{1,3}(?:,[0-9]{3})+円|初期費用[^\n]{0,6}[:：]/, note: "見積書の担当" },
  { key: "号室を本文に書く", re: /[0-9０-９]{2,4}号室/, note: "" },
  { key: "絵文字なし", re: /^(?:(?!😊|😌|🙇|🌟|！！)[\s\S])*$/, note: "スモラの文体は絵文字と！！が特徴" },
];

const norm = (s: string) => s.replace(/\s+/g, "").trim();

async function main() {
  const days = Number(process.env.DAYS ?? 180);

  // ── ① 記録は溜まっているか ──
  console.log(`=== ① AIX テンプレートの生成文は記録されているか（直近${days}日）===`);
  const gl = await page("aix_generate_log", "id, conversation_id, action_type, status, generated_text, created_at", "created_at", days);
  const byStatus = new Map<string, number>();
  for (const r of gl) byStatus.set(String(r.status ?? "(null)"), (byStatus.get(String(r.status ?? "(null)")) ?? 0) + 1);
  console.log(`   aix_generate_log: ${gl.length}件`);
  for (const [k, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(5)}件  status=${k}`);

  // ai_reply_examples（entry_source=aix_template）: ai_draft と sent_reply が揃うと差分が取れる
  const ex = await page("ai_reply_examples", "id, conversation_id, ai_draft, sent_reply, entry_source, aix_action, created_at", "created_at", days);
  const tmpl = ex.filter((r) => String(r.entry_source ?? "").includes("aix"));
  const withBoth = tmpl.filter((r) => {
    const d = String(r.ai_draft ?? ""), s = String(r.sent_reply ?? "");
    return d && s && d !== "__SHOWN__" && d.length > 6 && s.length > 6;
  });
  console.log(`\n   ai_reply_examples の AIX 由来: ${tmpl.length}件`);
  console.log(`     うち 生成文と実送信が**両方ある**（＝差分が取れる）: ${withBoth.length}件 (${tmpl.length ? ((withBoth.length / tmpl.length) * 100).toFixed(1) : "-"}%)`);
  const bySrc = new Map<string, { n: number; both: number }>();
  for (const r of tmpl) {
    const k = String(r.entry_source ?? "?");
    if (!bySrc.has(k)) bySrc.set(k, { n: 0, both: 0 });
    bySrc.get(k)!.n++;
  }
  for (const r of withBoth) bySrc.get(String(r.entry_source ?? "?"))!.both++;
  for (const [k, v] of [...bySrc.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`     ${k.padEnd(22)} ${String(v.n).padStart(4)}件（差分あり ${v.both}件）`);
  }

  if (withBoth.length === 0) {
    console.log(`\n   ❌ 差分が1件も取れない。生成文（ai_draft）が残っていないのが原因。`);
    console.log(`      設計知見「生成した文を残していない経路は、学習も原因追跡もできない」がそのまま当てはまる。`);
    return;
  }

  // ── ② 生成文と実送信はどれだけ違うか ──
  console.log(`\n=== ② 生成文と実送信の違い（${withBoth.length}件）===`);
  let same = 0;
  const lenDiff: number[] = [];
  for (const r of withBoth) {
    const d = norm(String(r.ai_draft)), s = norm(String(r.sent_reply));
    if (d === s) same++;
    lenDiff.push(String(r.sent_reply).length - String(r.ai_draft).length);
  }
  console.log(`   そのまま送られた: ${same}件 (${((same / withBoth.length) * 100).toFixed(1)}%)`);
  const sorted = [...lenDiff].sort((a, b) => a - b);
  console.log(`   長さの差（実送信 − 生成）: 中央値 ${sorted[Math.floor(sorted.length / 2)]}字（25% ${sorted[Math.floor(sorted.length * 0.25)]} / 75% ${sorted[Math.floor(sorted.length * 0.75)]}）`);

  // ── ③ 要素ごとの差（生成にあって実送信に無い＝スタッフが消した／その逆）──
  console.log(`\n=== ③ 要素ごとの差（生成にあって消された ＝ 直すべき癖）===`);
  console.log(`   ${"要素".padEnd(30)} 生成   実送信  消された  足された`);
  for (const df of DIFFS) {
    let inDraft = 0, inSent = 0, removed = 0, added = 0;
    for (const r of withBoth) {
      const d = String(r.ai_draft), s = String(r.sent_reply);
      const a = df.re.test(d), b = df.re.test(s);
      if (a) inDraft++;
      if (b) inSent++;
      if (a && !b) removed++;
      if (!a && b) added++;
    }
    const mark = removed >= 3 ? " ←" : "";
    console.log(`   ${df.key.padEnd(30)} ${String(inDraft).padStart(4)}  ${String(inSent).padStart(5)}  ${String(removed).padStart(7)}  ${String(added).padStart(7)}${mark}`);
  }
  console.log(`\n   ※「消された」が多い要素＝生成の癖。「足された」が多い＝生成が書けていない要素`);

  // ── ④ 実物（違いが大きい順に読む）──
  console.log(`\n=== ④ 違いが大きい実物（8件・目で読む）===`);
  const ranked = withBoth
    .map((r) => ({ r, diff: Math.abs(String(r.sent_reply).length - String(r.ai_draft).length) }))
    .filter((x) => norm(String(x.r.ai_draft)) !== norm(String(x.r.sent_reply)))
    .sort((a, b) => b.diff - a.diff);
  for (const { r } of ranked.slice(0, 8)) {
    console.log(`\n   ── [${r.entry_source}${r.aix_action ? ` / ${r.aix_action}` : ""}]`);
    console.log(`   生成  : ${String(r.ai_draft).replace(/\n/g, " ／ ").slice(0, 180)}`);
    console.log(`   実送信: ${String(r.sent_reply).replace(/\n/g, " ／ ").slice(0, 180)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
