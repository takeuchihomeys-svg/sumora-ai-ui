// 「7万円くらい」の「くらい／ぐらい」を、スタッフは実際にどう書いているか（読み取りのみ）
// 2026-09-22 竹内「くらいって等使わない。このような部分のいいまわし改善する」
//   実物: お客様の条件フォーム「7万くらい」→ AI「浪速区・西区周辺から7万円くらい・1K以上…」→ スタッフが「7万円程」に直して送信
// 実行: npx tsx --env-file=.env.local scripts/audit-kurai.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
// 数量（金額・帖・分・㎡・件・日・時）の後ろの「ぼかし」の言い方
const QTY = String.raw`[0-9０-９一二三四五六七八九十.．,，]+\s*(?:万円|万|円|千円|帖|畳|分|㎡|平米|件|日|時|ヶ月|か月|カ月|年)`;
const FORMS: Array<[string, RegExp]> = [
  ["くらい／ぐらい", new RegExp(`${QTY}\\s*(?:くらい|ぐらい|位)`)],
  ["程", new RegExp(`${QTY}\\s*程(?!度)`)],
  ["程度", new RegExp(`${QTY}\\s*程度`)],
  ["前後", new RegExp(`${QTY}\\s*前後`)],
  ["以内", new RegExp(`${QTY}\\s*以内`)],
  ["まで", new RegExp(`${QTY}\\s*まで`)],
];
// 数量の無い「くらい」（「どのくらい」「同じくらい」「それくらい」）
const BARE_KURAI = /(?:どの|どれ|同じ|それ|これ|あれ|この|その)?(?:くらい|ぐらい)/;

async function main() {
  const counts = new Map<string, number>(); let staffN = 0; let bare = 0; const bareEx: string[] = []; const kuraiEx: string[] = [];
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("messages").select("text, is_aix_generated").eq("sender", "staff").gte("created_at", new Date(Date.now() - 365 * 86400_000).toISOString()).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null }>;
    for (const x of r) {
      const t = x.text ?? ""; staffN++;
      for (const [k, re] of FORMS) if (re.test(t)) { counts.set(k, (counts.get(k) ?? 0) + 1); if (k === "くらい／ぐらい" && kuraiEx.length < 8) kuraiEx.push(t.match(new RegExp(`[^\\n]{0,25}${re.source}[^\\n]{0,15}`))?.[0] ?? ""); }
      if (BARE_KURAI.test(t) && !FORMS[0][1].test(t)) { bare++; if (bareEx.length < 8) bareEx.push(t.match(/[^\n]{0,25}(?:くらい|ぐらい)[^\n]{0,15}/)?.[0] ?? ""); }
    }
    if (r.length < 1000) break;
  }
  console.log(`=== スタッフの実送信（365日）${staffN}通: 数量の後ろの言い方 ===`);
  for (const [k] of FORMS) console.log(`   ${k.padEnd(10)} ${counts.get(k) ?? 0}通`);
  console.log(`   （数量の無い「くらい・ぐらい」${bare}通）`);
  console.log(`\n【実送信の「数量＋くらい／ぐらい」の実例】`); for (const e of kuraiEx) console.log("   ", e);
  console.log(`\n【実送信の数量の無い「くらい」の実例】`); for (const e of bareEx) console.log("   ", e);

  // AI 下書き → 実送信
  const ex: Array<{ ai_draft: string | null; sent_reply: string | null; customer_message: string | null }> = [];
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from("ai_reply_examples").select("ai_draft, sent_reply, customer_message").ilike("ai_draft", "%くらい%").range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof ex; ex.push(...r); if (r.length < 1000) break;
  }
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from("ai_reply_examples").select("ai_draft, sent_reply, customer_message").ilike("ai_draft", "%ぐらい%").range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof ex; ex.push(...r); if (r.length < 1000) break;
  }
  const withQty = ex.filter((x) => FORMS[0][1].test(x.ai_draft ?? "") && (x.sent_reply ?? "").trim());
  const kept = withQty.filter((x) => FORMS[0][1].test(x.sent_reply ?? ""));
  const custSaid = withQty.filter((x) => /くらい|ぐらい/.test(x.customer_message ?? ""));
  console.log(`\n=== AI の下書きに「数量＋くらい／ぐらい」: ${withQty.length}件 → 実送信に残った ${kept.length}件（お客様がくらいと書いていた ${custSaid.length}件）===`);
  const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〈お客様〉").replace(/\n/g, " ／ ");
  for (const x of withQty.slice(0, 10)) {
    const a = (x.ai_draft ?? "").match(new RegExp(`[^\\n]{0,20}${FORMS[0][1].source}[^\\n]{0,10}`))?.[0] ?? "";
    const line = (x.sent_reply ?? "").split("\n").find((l) => /万|円|帖|分/.test(l)) ?? "";
    console.log(`   AI: ${mask(a)}\n   送: ${mask(line).slice(0, 80)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
