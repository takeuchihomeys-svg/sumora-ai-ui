// AIX【物件確認した】の「申込あり」が文に反映されているか（読み取りのみ）
//
// 2026-09-21 竹内「申込ありボタンは物件毎につける。そうすれば、どの物件が申込ありなのか判断できるから」
//
// ■ コードを読んで分かった今の形
//   入力が**2か所**ある:
//     ① 全体の「申込状況」（body.available_application = "yes"/"no"）… 物件カードの上
//     ② 物件ごとの「募集状況」（body.prop_statuses[i] = "unavailable"＝申込あり）… 物件カードの中
//   そして aix/action は
//     ・物件ごとのステータスが入っていれば**①を無視して**②の経路に入る（route.ts の pattern==="available" 分岐）
//     ・複数件（propCount>1）は箇条書きに「※ 申込あり」が出る
//     ・**1件（propCount===1）は status==="unavailable" の分岐が無く**、
//       「〇〇 現在募集中となります！！」に落ちる疑いがある（＝申込ありなのに募集中と言う）
//
// ■ ここで測ること
//   ① 「申込あり」を選んだ送信で、実送信の文に申込の説明が入っているか
//   ② 1件の時と複数件の時で差が出ているか（1件で落ちているなら仮説どおり）
//   ③ スタッフが実際に使う「申込あり」の言い回し（＝直す時の骨組み）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-check-application.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 180);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** 申込が入っていることを伝える言い回し */
const APP_EXISTS_RE = /(?:1番手|一番手|申込(?:み)?が入って|お申込みが入って|2番手|二番手|申込あり)/;
/** 「募集中」と言い切る言い回し（申込ありなら事実と食い違う可能性） */
const AVAILABLE_RE = /現在募集中となります|募集中となります/;

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  // 生成ログから「申込あり」を選んだ送信を拾う
  const logs = await page("aix_generate_log", "id, action_type, generated_text, conditions_snapshot, created_at", "created_at", DAYS);
  const checks = logs.filter((r) => String(r.action_type ?? "").startsWith("property_check_result"));
  console.log(`=== AIX【物件確認した】の生成ログ ${checks.length}件（直近${DAYS}日）===\n`);

  type Snap = {
    prop_statuses?: string[] | null; available_application?: string | null;
    property_count?: number | null; check_pattern?: string | null;
    check_application_invite?: boolean | null;
  };
  const rows = checks.map((r) => {
    const s = (r.conditions_snapshot ?? {}) as Snap;
    return {
      text: String(r.generated_text ?? ""),
      statuses: Array.isArray(s.prop_statuses) ? s.prop_statuses : [],
      appAll: s.available_application ?? null,
      count: typeof s.property_count === "number" ? s.property_count : null,
      pattern: s.check_pattern ?? null,
      appInvite: !!s.check_application_invite,
    };
  }).filter((x) => x.text);

  console.log(`=== ① 入力がどれだけ記録されているか ===`);
  console.log(`   本文がある ${rows.length}件`);
  console.log(`   prop_statuses が入っている      ${rows.filter((x) => x.statuses.length > 0).length}件`);
  console.log(`   available_application が入っている ${rows.filter((x) => x.appAll).length}件`);
  console.log(`   property_count が入っている      ${rows.filter((x) => x.count !== null).length}件`);

  // ② 物件ごとに「申込あり」を選んだ送信
  const withUnavail = rows.filter((x) => x.statuses.includes("unavailable"));
  console.log(`\n=== ② 物件ごとに「申込あり」を選んだ送信 ${withUnavail.length}件 ===`);
  if (withUnavail.length > 0) {
    const single = withUnavail.filter((x) => (x.count ?? x.statuses.length) === 1);
    const multi = withUnavail.filter((x) => (x.count ?? x.statuses.length) > 1);
    const okSingle = single.filter((x) => APP_EXISTS_RE.test(x.text)).length;
    const okMulti = multi.filter((x) => APP_EXISTS_RE.test(x.text)).length;
    console.log(`   1件の時   ${single.length}件 ／ 申込の説明が入っている ${okSingle}件（${pct(okSingle, single.length)}）`);
    console.log(`   複数件の時 ${multi.length}件 ／ 申込の説明が入っている ${okMulti}件（${pct(okMulti, multi.length)}）`);
    // 申込ありなのに「募集中」と言い切っている物
    const contradict = withUnavail.filter((x) => AVAILABLE_RE.test(x.text) && !APP_EXISTS_RE.test(x.text));
    console.log(`   **申込ありなのに「募集中」とだけ言っている: ${contradict.length}件（${pct(contradict.length, withUnavail.length)}）**`);
    for (const x of contradict.slice(0, 5)) {
      console.log(`     [件数${x.count ?? x.statuses.length} / statuses=${x.statuses.join(",")}]`);
      console.log(`       ${mask(x.text).replace(/\n/g, " ／ ").slice(0, 110)}`);
    }
  }

  // ③ 全体の「申込状況」を選んだ送信
  const withAppAll = rows.filter((x) => x.appAll === "yes");
  console.log(`\n=== ③ 全体の「申込状況＝申込あり」を選んだ送信 ${withAppAll.length}件 ===`);
  if (withAppAll.length > 0) {
    const reflected = withAppAll.filter((x) => APP_EXISTS_RE.test(x.text)).length;
    console.log(`   申込の説明が入っている ${reflected}件（${pct(reflected, withAppAll.length)}）`);
    const bothInputs = withAppAll.filter((x) => x.statuses.length > 0);
    console.log(`   **物件ごとのステータスも同時に入っている: ${bothInputs.length}件（${pct(bothInputs.length, withAppAll.length)}）** ← 入力が2か所ある`);
    const conflict = bothInputs.filter((x) => !x.statuses.includes("unavailable"));
    console.log(`   そのうち物件ごとは「申込あり」でない（食い違い）: ${conflict.length}件`);
  }

  // ④ スタッフの実送信で「申込あり」をどう書いているか
  const ex = await page("ai_reply_examples", "id, sent_reply, aix_action, created_at", "created_at", DAYS);
  const checkEx = ex.filter((r) => String(r.aix_action ?? "").startsWith("property_check_result") && String(r.sent_reply ?? "").trim());
  const appEx = checkEx.filter((r) => APP_EXISTS_RE.test(String(r.sent_reply)));
  console.log(`\n=== ④ スタッフの実送信 ${checkEx.length}件 ／ 申込の説明を含む ${appEx.length}件（${pct(appEx.length, checkEx.length)}）===`);
  const phrases = new Map<string, number>();
  for (const r of appEx) {
    for (const line of String(r.sent_reply).split("\n")) {
      if (APP_EXISTS_RE.test(line)) {
        const k = mask(line.trim()).replace(/[^\s]{1,20}号室/g, "〈物件〉").slice(0, 60);
        phrases.set(k, (phrases.get(k) ?? 0) + 1);
      }
    }
  }
  console.log(`   ─ 申込の説明の言い回し（上位12）─`);
  for (const [p, n] of [...phrases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${String(n).padStart(3)}回  ${p}`);
  }

  // ⑤ 申込ありの物件が複数ある時、どう書き分けているか
  console.log(`\n=== ⑤ 実送信で「※ 申込あり」の箇条書きを使っている物 ===`);
  const bullet = checkEx.filter((r) => /※\s*申込あり/.test(String(r.sent_reply)));
  console.log(`   ${bullet.length}件（${pct(bullet.length, checkEx.length)}）`);
  for (const r of bullet.slice(0, 4)) {
    console.log(`     ${mask(String(r.sent_reply)).replace(/\n/g, " ／ ").slice(0, 150)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
