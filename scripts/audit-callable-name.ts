// 呼びかけに使えない表示名（絵文字・記号だけ）と「お客様」呼びかけの線を引く（読み取りのみ）
//
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
// scripts/audit-ai-only-phrases.ts が見つけた「AI だけが書く言い回し」の上位2つは同じ根だった:
//   ①「お客様本日お時間頂きありがとうございました！！」型（名前の代わりに「お客様」）22回
//   ②「🐷🐽🐷🐽🐷🐽🐷🐽さんお世話になっております！！」型（絵文字の表示名で呼びかけ）6回
// どちらも実送信には1通も無い。＝**名前が呼びかけに使えない時の扱いが決まっていない**。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 呼びかけに使える文字（日本語・英字・数字）。これが1つも無い名前は呼びかけに使えない */
const CALLABLE_CHAR = /[ぁ-んァ-ヶー一-龥a-zA-ZＡ-Ｚａ-ｚ0-9０-９]/u;

async function grab(table: "messages" | "ai_reply_examples", col: string) {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const out: Array<{ t: string; conv: string; at: string }> = [];
  for (let p = 0; p < 16; p++) {
    const { data } = table === "messages"
      ? await sb.from(table).select(`${col}, conversation_id, created_at`).eq("sender", "staff").gte("created_at", since)
          .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999)
      : await sb.from(table).select(`${col}, conversation_id, created_at`).gte("created_at", since)
          .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    for (const x of r) { const t = String(x[col] ?? ""); if (t && t !== "__SHOWN__") out.push({ t, conv: String(x.conversation_id ?? ""), at: String(x.created_at) }); }
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  // ── ① 呼びかけに使えない表示名の会話 ──
  const { data } = await sb.from("conversations").select("id, customer_name, status").limit(6000);
  const convs = (data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>;
  const named = convs.filter((c) => (c.customer_name ?? "").trim());
  const unusable = named.filter((c) => !CALLABLE_CHAR.test((c.customer_name ?? "").trim()));
  console.log(`=== 会話 ${convs.length}件（名前あり ${named.length}件）===`);
  console.log(`  呼びかけに使えない表示名（絵文字・記号だけ）: **${unusable.length}件**`);
  for (const c of unusable.slice(0, 20)) console.log(`    「${c.customer_name}」 [${c.status}]`);
  // 一部だけ記号（「💋chibi💋」「🌶7」）も呼びかけとしては危うい
  const partly = named.filter((c) => {
    const n = (c.customer_name ?? "").trim();
    return CALLABLE_CHAR.test(n) && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(n);
  });
  console.log(`  名前に絵文字が混ざる: ${partly.length}件`);
  for (const c of partly.slice(0, 12)) console.log(`    「${c.customer_name}」`);

  const sent = await grab("messages", "text");
  const draft = await grab("ai_reply_examples", "ai_draft");
  console.log(`\n実送信 ${sent.length}通 ／ 下書き ${draft.length}件`);

  // ── ② 「お客様」を名前の代わりに使う形 ──
  const PATTERNS: Array<{ id: string; re: RegExp }> = [
    { id: "行頭「お客様」＋本題（呼びかけ代用）", re: /(?:^|\n)お客様(?![はがのにへとも、。！!？?）\)])[^\n]{2,}/ },
    { id: "「お客様ご希望の」", re: /お客様ご希望の/ },
    { id: "「お客様お送りいただきました」", re: /お客様お送り(?:いただ|頂)/ },
    { id: "「お客様本日」", re: /お客様本日/ },
    { id: "「お客様確認させて」", re: /お客様確認させて/ },
    { id: "絵文字だけの呼びかけ（〇〇さんお世話に）", re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]{2,}さん/u },
    { id: "★ お客様側の立場で書く（お願いできますでしょうか）", re: /(?:お願い|ご対応|ご確認)(?:でき|出来)ますでしょうか/ },
    { id: "★ 見積を「お願いする」側", re: /(?:御)?見積(?:書|もり|り)?[^\n。！!]{0,12}(?:お願い(?:でき|いたし|し)ます|お願いできますでしょうか)/ },
  ];
  console.log(`\n${"型".padEnd(42)} 実送信 / 下書き`);
  console.log("─".repeat(72));
  for (const p of PATTERNS) {
    const s = sent.filter((x) => p.re.test(x.t));
    const d = draft.filter((x) => p.re.test(x.t));
    if (s.length === 0 && d.length === 0) continue;
    console.log(`${p.id.padEnd(42)} ${String(s.length).padStart(5)} / ${String(d.length).padStart(5)}${s.length === 0 ? "  🟢" : "  🔴"}`);
    for (const x of s.slice(0, 3)) console.log(`      [実送信 ${x.at.slice(5, 16)}] ${x.t.replace(/\n/g, " ").slice(0, 92)}`);
    for (const x of d.slice(0, 2)) console.log(`      [下書き ${x.at.slice(5, 16)}] ${x.t.replace(/\n/g, " ").slice(0, 92)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
