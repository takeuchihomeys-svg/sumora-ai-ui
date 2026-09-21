// 新しい指摘（APPLY_THANKS_NO_APPLICATION）が実送信を誤って止めないか（読み取りのみ）
//
// 2026-09-21 竹内「申込ありがとうございますって申込とは審査の申込みの時に使うものであって、
//   このような場面で使わない」
//
// 設計知見の手順⑦全件監査・⑧監査で止める。
// この指摘は blockAlways（自動送信を止める）なので、**実送信を1通も止めてはいけない**。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-thanks-guard.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 400);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(2)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

/** ⚠ final-check.ts の BANNED_PATTERNS と同じ形にすること（四者同名） */
const APPLY_THANKS_RE = /お?申込(?:み|)(?:いただき|頂き|下さり|くださり)?(?:誠に)?ありがとう/;
const SKIP_IF_HIST_RE = /お申込(?:み)?(?:完了|手続き|させて(?:頂|いただ)き|進め|入(?:り|って))|審査(?:中|結果|進め|に進)|申込書|1番手|一番手|お部屋(?:を)?(?:抑え|押さえ)(?:させて|ました)/;

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
  // ① お客様への実送信（ai_reply_examples）
  const ex = await page("ai_reply_examples", "id, conversation_id, sent_reply, created_at", DAYS);
  const sent = ex.filter((r) => String(r.sent_reply ?? "").trim());
  const hit = sent.filter((r) => APPLY_THANKS_RE.test(String(r.sent_reply)));
  console.log(`=== ① 実送信（手本）${sent.length}通 ===`);
  console.log(`   この指摘に当たる通: **${hit.length}通（${pct(hit.length, sent.length)}）**\n`);

  // ② LINE の生のスタッフ送信（messages）でも確かめる（手本に入っていない通もある）
  const msgs = (await page("messages", "conversation_id, sender, text, created_at", DAYS))
    .filter((m) => String(m.sender) === "staff" && String(m.text ?? "").trim());
  const msgHit = msgs.filter((m) => APPLY_THANKS_RE.test(String(m.text)));
  console.log(`=== ② LINE のスタッフ送信 ${msgs.length}通 ===`);
  console.log(`   この指摘に当たる通: **${msgHit.length}通（${pct(msgHit.length, msgs.length)}）**\n`);

  if (msgHit.length === 0) {
    console.log(`   ✅ 1通も無い ＝ この形を止めても**実送信を1通も止めない**（誤削除0）`);
  } else {
    // 当たった通は、免除（申込が進んでいる会話）に救われるかを確かめる
    console.log(`   ─ 当たった通を1通ずつ読む（免除に救われるか）─`);
    const byConv = new Map<string, Array<{ text: string; at: number }>>();
    for (const m of msgs) {
      const c = String(m.conversation_id ?? "");
      const at = Date.parse(String(m.created_at ?? ""));
      if (!c || Number.isNaN(at)) continue;
      byConv.set(c, [...(byConv.get(c) ?? []), { text: String(m.text), at }]);
    }
    let saved = 0, blocked = 0;
    for (const m of msgHit) {
      const c = String(m.conversation_id ?? "");
      const at = Date.parse(String(m.created_at ?? ""));
      const hist = (byConv.get(c) ?? []).filter((x) => x.at < at).slice(-6).map((x) => x.text).join("\n");
      const exempt = SKIP_IF_HIST_RE.test(hist);
      if (exempt) saved++; else blocked++;
      console.log(`     ${exempt ? "✅免除" : "⚠止める"}  ${mask(String(m.text)).replace(/\n/g, " ／ ").slice(0, 100)}`);
    }
    console.log(`\n   免除に救われる ${saved}通 ／ **止めてしまう ${blocked}通**`);
    if (blocked > 0) console.log(`   ⚠ 0通でなければこの指摘は入れてはいけない（設計知見「出口は誤削除0でなければ入れない」）`);
  }

  // ③ 依頼の形（これから申し込んでもらう）を誤って巻き込まないか
  const REQUEST_LIKE = /お申込(?:み|)(?:いただき|頂き)(?![^。！!\n]{0,6}ありがとう)/;
  const reqHit = msgs.filter((m) => REQUEST_LIKE.test(String(m.text)));
  const reqAlsoHit = reqHit.filter((m) => APPLY_THANKS_RE.test(String(m.text)));
  console.log(`\n=== ③ 依頼の形（お申込みいただき、〜）${reqHit.length}通 ===`);
  console.log(`   そのうちこの指摘に当たる: **${reqAlsoHit.length}通** ← 0 でなければ形が混ざっている`);
  for (const m of reqAlsoHit.slice(0, 5)) {
    console.log(`     ${mask(String(m.text)).replace(/\n/g, " ／ ").slice(0, 100)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
