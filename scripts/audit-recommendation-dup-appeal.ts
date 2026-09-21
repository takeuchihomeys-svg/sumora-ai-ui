// AIX【物件オススメ】で同じ意味の訴求文が2つ並んでいないか（読み取りのみ）
//
// 2026-09-21 竹内「別のスタッフが送ってる質の悪い言い回しもあるから、そこも含めて改善する。直近の会話をみて。」
//
// 直近の実送信を目で読んで見つけた形（scripts/peek-recommendation-recent.ts）:
//   「新着でかなり条件のいいお部屋となります！！敷金礼金なしで、〇〇さんにかなりオススメ出来るお部屋となります！！」
//   「かなり条件のいいお部屋となります！！2024年3月築で…が、〇〇さんにかなりオススメ出来るお部屋となります！！」
//   ＝ **同じ意味の訴求が2つ並ぶ**。
//
// 原因の疑い: aix/action の newArrivalNote が
//   「『〜さんにかなりオススメ出来るお部屋となります！！』の**前**に
//    『新着でかなり条件のいいお部屋となります！！』を盛り込む」と指示していて、**設計上2つ並ぶ**。
//
// ⚠ 直す前に「スタッフが実際にどうしているか」を数える（設計知見「実送信で線を引く」）。
//   消すのは出口の削除なので、**スタッフが消している側でなければ触らない**。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-recommendation-dup-appeal.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 120);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** 「新着でかなり条件のいいお部屋となります」系（条件訴求） */
const COND_APPEAL_RE = /(?:新着で)?かなり条件のいいお部屋(?:が募集にで|が募集に出)?(?:ました|となります)/;
/** 「〇〇さんにかなりオススメ出来るお部屋となります」系（オススメ訴求） */
const REC_APPEAL_RE = /かなりオススメ出来るお部屋となります/;

async function page(days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, ai_draft, sent_reply, aix_action, entry_source, created_at")
      .in("aix_action", ["property_recommendation", "property_send"])
      .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

function hasBoth(t: string): boolean { return COND_APPEAL_RE.test(t) && REC_APPEAL_RE.test(t); }

async function main() {
  const rows = (await page(DAYS)).filter((r) => String(r.sent_reply ?? "").trim());
  console.log(`=== 直近${DAYS}日 物件オススメ・ピックアップの実送信 ${rows.length}件 ===\n`);

  // ① 実送信で2つ並んでいる率（＝スタッフが許している形か）
  const sentBoth = rows.filter((r) => hasBoth(String(r.sent_reply)));
  const sentCond = rows.filter((r) => COND_APPEAL_RE.test(String(r.sent_reply)));
  const sentRec = rows.filter((r) => REC_APPEAL_RE.test(String(r.sent_reply)));
  console.log(`=== ① 実送信 ===`);
  console.log(`   「かなり条件のいいお部屋」を含む      ${String(sentCond.length).padStart(4)}件（${pct(sentCond.length, rows.length)}）`);
  console.log(`   「かなりオススメ出来るお部屋」を含む  ${String(sentRec.length).padStart(4)}件（${pct(sentRec.length, rows.length)}）`);
  console.log(`   **両方が並ぶ**                        ${String(sentBoth.length).padStart(4)}件（${pct(sentBoth.length, rows.length)}）`);

  // ② AI の下書き → 実送信で、スタッフが片方を消しているか（ここが線の根拠）
  const pairs = rows.filter((r) => String(r.ai_draft ?? "").trim());
  const draftBoth = pairs.filter((r) => hasBoth(String(r.ai_draft)));
  const keptBoth = draftBoth.filter((r) => hasBoth(String(r.sent_reply))).length;
  const removedOne = draftBoth.length - keptBoth;
  console.log(`\n=== ② AI が2つ並べた時、スタッフはどうしたか ===`);
  console.log(`   下書きと実送信が揃う ${pairs.length}件`);
  console.log(`   AI が2つ並べた       ${draftBoth.length}件（${pct(draftBoth.length, pairs.length)}）`);
  console.log(`     そのまま残した     ${keptBoth}件（${pct(keptBoth, draftBoth.length)}）`);
  console.log(`     **片方を消した**   ${removedOne}件（${pct(removedOne, draftBoth.length)}）`);
  // 逆向き: AI が1つだったのにスタッフが2つにした（＝2つが正しい形なら足すはず）
  const draftOne = pairs.filter((r) => !hasBoth(String(r.ai_draft)));
  const addedSecond = draftOne.filter((r) => hasBoth(String(r.sent_reply))).length;
  console.log(`   AI が1つだった       ${draftOne.length}件 ／ スタッフが2つに**足した** ${addedSecond}件（${pct(addedSecond, draftOne.length)}）`);

  // ③ どちらを残しているか
  console.log(`\n=== ③ 片方を消した時、どちらを残したか ===`);
  const removed = draftBoth.filter((r) => !hasBoth(String(r.sent_reply)));
  const keptCond = removed.filter((r) => COND_APPEAL_RE.test(String(r.sent_reply))).length;
  const keptRec = removed.filter((r) => REC_APPEAL_RE.test(String(r.sent_reply))).length;
  const keptNeither = removed.length - keptCond - keptRec;
  console.log(`   「かなり条件のいい」を残した      ${keptCond}件`);
  console.log(`   「かなりオススメ出来る」を残した  ${keptRec}件`);
  console.log(`   どちらも消した                    ${keptNeither}件`);

  console.log(`\n=== ④ 2つ並んでいる実物（目で読む）===`);
  for (const r of sentBoth.slice(0, 6)) {
    const head = mask(String(r.sent_reply)).split("\n").filter(Boolean).slice(0, 3).join(" ／ ");
    console.log(`   [${r.aix_action}] ${head.slice(0, 130)}`);
  }

  console.log(`\n=== ⑤ 判定の材料 ===`);
  console.log(`   ・実送信で2つ並ぶのが多数なら「並べてよい形」＝触らない`);
  console.log(`   ・スタッフが片方を消しているなら「並べない」が正 → 生成の指示を直す`);
}
main().catch((e) => { console.error(e); process.exit(1); });
