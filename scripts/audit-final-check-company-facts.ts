// 会社の事実に反する断定（company-fact-guard）の全件監査（読み取りのみ・LLM 呼び出し 0）
//
// 2026-09-23 竹内「会社の事実に反する断定を出口で止める規則の部分、ファイナルチェックが問題なく機能しているか確認する」
// 設計知見の型 ③実送信で線を引く ④誤削除0 ⑦全件監査（目で読む）。件数だけでなく**当たった文を全部そのまま表示**する。
//
//   A. 実送信（スタッフ・直近365日）に純関数を**ゲート無し**で当てる → 当たり = 誤削除の候補（0 でなければ入れない）
//      当たった通は、その直前のお客様の発言（3通）で本番のゲート（matchCompanyFacts）が開くかも併記する
//   B. 近い形（広い正規表現）の実送信を全部表示し、純関数が「残す」と判定した物を目で確かめる（除外が正しいか）
//   C. AI 下書き（ai_reply_examples.ai_draft・365日）と会話の下書き（conversations.ai_draft）で何が止まるか（変換の前後）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-final-check-company-facts.ts [--days=365] [--show=all]
import { createClient } from "@supabase/supabase-js";
import { findCompanyFactContradictionsUngated, splitSentencesForFactGuard, COMPANY_FACT_CONTRADICTIONS } from "../app/lib/company-fact-guard";
import { matchCompanyFacts } from "../app/lib/company-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);
const SHOW_ALL = process.argv.includes("--show=all");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

/** 個人情報を出さない: 呼びかけの名前は伏せる */
const mask = (t: string) => t.replace(/([^\s、。！!？?「」（）()0-9０-９]{1,8})(さん|様)/g, "〇〇$2");
const one = (t: string, n = 160) => mask(t.replace(/\n/g, "␤").slice(0, n));

async function pageAll<T>(run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await run(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${error.message}`); break; }
    const r = (data ?? []) as T[];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

type Msg = { id?: string; conversation_id: string; sender: string; text: string | null; created_at: string };

/** B で使う「近い形」（純関数より広い網。ここに当たった物を全部読んで、除外が正しいかを目で確かめる） */
const NEAR: Record<string, RegExp> = {
  room_photo: /(?:写真|画像|動画)[^。！!？?\n]{0,24}(?:ご用意|用意)[^。！!？?\n]{0,6}(?:出来|でき)て(?:い|お)(?:ない|りません|いません|らず)|(?:写真|画像|動画)[^。！!？?\n]{0,20}(?:ございません|御座いません|ありません|無い|ない)|撮影[^。！!？?\n]{0,10}(?:おりません|いません|おらず|いない|出来ません|できません|できかね|出来かね)/,
  store: /(?:店舗|事務所|オフィス)[^。！!？?\n]{0,14}(?:来店|来社|お越し|相談|面談|対面)|対面で[^。！!？?\n]{0,8}(?:相談|面談)|ご来店/,
  credit_card: /(?:クレジット|クレカ|カード(?:払|決済))[^。！!？?\n]{0,16}(?:おりません|いません|おらず|いない|ません|不可|かね)/,
  emergency_contact: /緊急連絡先[^。！!？?\n]{0,12}(?:不要|必要|必須|任意|なくても|無くても)/,
  viewing_method: /オンライン(?:での|で|の|にて)?(?:内覧|内見)[^。！!？?\n]{0,14}(?:おりません|いません|おらず|いない|ません|不可|かね|対応外)/,
};

async function main() {
  console.log(`=== 会社の事実に反する断定の全件監査（直近${DAYS}日・読み取りのみ）===`);
  console.log(`規則: ${COMPANY_FACT_CONTRADICTIONS.map((c) => c.factId).join(" / ")}\n`);

  const staff = await pageAll<Msg>((a, b) =>
    sb.from("messages").select("id, conversation_id, sender, text, created_at").eq("sender", "staff").gte("created_at", since)
      .order("created_at", { ascending: false }).range(a, b));
  const staffRows = staff.filter((r) => (r.text ?? "").trim() && r.text !== "__SHOWN__" && r.text !== "[画像]");
  console.log(`実送信（スタッフ）: ${staffRows.length}通\n`);

  // ── A. ゲート無しで当たる実送信（＝誤削除の候補）──
  console.log("A. 純関数がゲート無しで当たる実送信（0 でなければ block で入れない）");
  const byFact = new Map<string, number>();
  let hitTotal = 0;
  for (const r of staffRows) {
    const hits = findCompanyFactContradictionsUngated(r.text ?? "");
    if (hits.length === 0) continue;
    hitTotal++;
    // 直前のお客様の発言（3通）で本番のゲートが開くか
    const { data: prev } = await sb.from("messages").select("text, sender, created_at").eq("conversation_id", r.conversation_id)
      .eq("sender", "customer").lt("created_at", r.created_at).order("created_at", { ascending: false }).limit(3);
    const custTexts = ((prev ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "");
    const asked = new Set(matchCompanyFacts(custTexts).map((f) => f.id));
    for (const h of hits) {
      byFact.set(h.factId, (byFact.get(h.factId) ?? 0) + 1);
      const gated = asked.has(h.factId);
      console.log(`   ❌ [${h.factId}] ${gated ? "ゲート開（本番でも止まる）" : "ゲート閉（本番では止まらない）"} ${r.created_at.slice(0, 10)}`);
      console.log(`      文: ${one(h.sentence)}`);
      console.log(`      全文: ${one(r.text ?? "", 220)}`);
      console.log(`      直前のお客様: ${custTexts.map((t) => one(t, 60)).join(" ／ ") || "（無し）"}`);
    }
  }
  console.log(`   → 当たった実送信: ${hitTotal}通 ${[...byFact.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "（0）"}\n`);

  // ── B. 近い形を全部読む ──
  console.log("B. 近い形（広い網）の実送信を全部表示。✅残る＝純関数は当てない／❌落ちる＝当たる");
  for (const [factId, near] of Object.entries(NEAR)) {
    const rows: Array<{ s: string; hit: boolean; date: string }> = [];
    for (const r of staffRows) {
      for (const s of splitSentencesForFactGuard(r.text ?? "")) {
        if (!near.test(s)) continue;
        const hit = findCompanyFactContradictionsUngated(s).some((h) => h.factId === factId);
        rows.push({ s, hit, date: r.created_at.slice(0, 10) });
      }
    }
    const uniq = new Map<string, { hit: boolean; date: string; n: number }>();
    for (const r of rows) { const k = mask(r.s); const u = uniq.get(k); if (u) u.n++; else uniq.set(k, { hit: r.hit, date: r.date, n: 1 }); }
    console.log(`\n   [${factId}] 近い形: ${rows.length}文（重複除去 ${uniq.size}）`);
    const list = [...uniq.entries()];
    const limit = SHOW_ALL ? list.length : Math.min(list.length, factId === "store" ? 60 : 200);
    for (const [s, u] of list.slice(0, limit)) console.log(`      ${u.hit ? "❌落ちる" : "✅残る "} ×${u.n} ${u.date} ${s.slice(0, 150)}`);
    if (list.length > limit) console.log(`      …他 ${list.length - limit}（--show=all で全部）`);
  }

  // ── C. AI 下書きで何が止まるか ──
  const drafts = await pageAll<{ ai_draft: string | null; sent_reply: string | null; created_at: string; customer_message?: string | null }>((a, b) =>
    sb.from("ai_reply_examples").select("ai_draft, sent_reply, created_at, customer_message").gte("created_at", since)
      .order("created_at", { ascending: false }).range(a, b));
  console.log(`\nC. AI 下書き（ai_reply_examples・${drafts.length}件）で当たる物（変換の前後）`);
  let dHit = 0;
  for (const d of drafts) {
    const hits = findCompanyFactContradictionsUngated(d.ai_draft ?? "");
    if (hits.length === 0) continue;
    dHit++;
    const asked = new Set(matchCompanyFacts(d.customer_message ?? "").map((f) => f.id));
    for (const h of hits) {
      console.log(`   [${h.factId}] ${asked.has(h.factId) ? "ゲート開" : "ゲート閉"} ${d.created_at.slice(0, 10)} 下書きの文: ${one(h.sentence)}`);
      console.log(`      お客様: ${one(d.customer_message ?? "", 80)}`);
      console.log(`      実送信: ${one(d.sent_reply ?? "（削除・未送信）", 160)}`);
    }
  }
  console.log(`   → 当たった下書き: ${dHit}件`);

  const convs = await pageAll<{ id: string; ai_draft: string | null; updated_at: string }>((a, b) =>
    sb.from("conversations").select("id, ai_draft, updated_at").not("ai_draft", "is", null).gte("updated_at", since)
      .order("updated_at", { ascending: false }).range(a, b));
  console.log(`\n   会話の現在の下書き（conversations.ai_draft・${convs.length}件）で当たる物`);
  let cHit = 0;
  for (const c of convs) {
    const hits = findCompanyFactContradictionsUngated(c.ai_draft ?? "");
    if (hits.length === 0) continue;
    cHit++;
    for (const h of hits) console.log(`   [${h.factId}] ${c.id.slice(0, 8)} ${c.updated_at.slice(0, 10)} ${one(h.sentence)}`);
  }
  console.log(`   → 当たった会話の下書き: ${cHit}件`);
}

main().catch((e) => { console.error(e); process.exit(1); });
