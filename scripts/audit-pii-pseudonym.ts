// scripts/audit-pii-pseudonym.ts
// 本番の実データ全件に pii-pseudonym を当てて「往復で元に戻るか」「何が伏せられたか」「誤爆していないか」を確かめる。
//
// 2026-09-19 竹内「マスキングする仕組みを作る」→ 繋ぐ前に全件で確かめる
//   （設計知見「落とす仕組みを入れたら、必ず過去の全部に当てて何が消えるかを目で読む。
//     テストは自分が書いた入力しか通らない」）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-pii-pseudonym.ts [--days=365]
export {};
import { createClient } from "@supabase/supabase-js";
import { createMasker, isApplicationPayload, APPLICATION_FORM_PLACEHOLDER, type MaskKind } from "../app/lib/pii-pseudonym";
import { isFilledSumoraForm } from "../app/lib/condition-format";
import { isApplicationFormMessage } from "../app/lib/application-form-detect";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL / key が未設定（--env-file=.env.local）"); process.exit(2); }
const sb = createClient(url, key);

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 365);
const since = new Date(Date.now() - days * 86400_000).toISOString();

/** 物件・条件が壊れていないか見るための語（実データに多い形） */
const KEEP_PATTERNS: Array<[string, RegExp]> = [
  ["家賃の金額", /\d+(?:\.\d+)?\s*万円/],
  ["間取り", /\d\s*(?:LDK|DK|K|R)\b/i],
  ["築年数", /築\s*\d+\s*年/],
  ["駅徒歩", /徒歩\s*\d+\s*分/],
  ["物件の住所（住所：）", /住所\s*[:：]/],
  ["固定電話", /0(?!\d0[-ー－\s])\d{1,4}[-ー－]\d{1,4}[-ー－]\d{3,4}/],
  // 2026-09-19 の監査で見つけた誤爆: 裸の西暦を生年月日として伏せると、これらが消える
  ["入居希望日", /入居希望日[^\n]{0,4}\d{4}\s*年/],
  ["入社日", /入社日[^\n]{0,4}\d{4}\s*年/],
  ["今年前後の日付", /202[6-9]\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/],
];

async function main() {
  console.log(`── pii-mask 監査（直近 ${days} 日）`);

  // 正解集合: 全会話のお客様名（事例に出る他人の名前を照合するため）
  const { data: convs, error: cErr } = await sb.from("conversations").select("id, customer_name");
  if (cErr) { console.error("conversations 取得失敗:", cErr.message); process.exit(1); }
  const nameByConv = new Map<string, string>();
  const allNames: string[] = [];
  for (const c of (convs ?? []) as Array<{ id: string; customer_name: string | null }>) {
    const nm = (c.customer_name ?? "").trim();
    if (nm) { nameByConv.set(c.id, nm); allNames.push(nm); }
  }
  const knownNames = [...new Set(allNames)];
  console.log(`  会話 ${nameByConv.size} 件 / 名前 ${knownNames.length} 種類`);

  let total = 0, broken = 0, leftover = 0;
  // 竹内「物件検索のフォーマットはちゃんと全部のこして、お申込みに関係する個人情報は渡らないように」
  let searchForms = 0, searchFormsDropped = 0;   // 物件検索フォーマット: 落ちたら重大な誤り
  let applyForms = 0, applyFormsDropped = 0;     // 申込の個人情報: 落ちなければ重大な漏れ
  let mentionOnly = 0;                            // 「申込フォーム」の語だけで中身が無い文（落とさないのが正解）
  const applyLeakSamples: string[] = [];
  const masked: Record<MaskKind, number> = { name: 0, mobile: 0, email: 0, birthday: 0, address: 0, employer: 0 };
  const keepBroken = new Map<string, number>();
  const brokenSamples: string[] = [];

  // ① messages（会話履歴）
  for (let page = 0; ; page++) {
    const { data, error } = await sb.from("messages")
      .select("id, conversation_id, text")
      .gte("created_at", since).not("text", "is", null)
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) { console.error("messages 取得失敗:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    for (const m of data as Array<{ id: string; conversation_id: string; text: string }>) {
      const src = m.text ?? "";
      if (!src) continue;
      total++;
      const masker = createMasker({
        conversationId: m.conversation_id,
        customerName: nameByConv.get(m.conversation_id) ?? null,
        knownNames,
      });
      const out = masker.mask(src);

      // ★ 物件検索のフォーマット（うちのテンプレートが埋まって返ってきた形）は必ず残す
      const isSearch = isFilledSumoraForm(src);
      if (isSearch) { searchForms++; if (out === APPLICATION_FORM_PLACEHOLDER) searchFormsDropped++; }
      // ★ 申込に関わる個人情報は必ず落とす（語だけで中身が無い文は落とさないのが正解）
      if (!isSearch && isApplicationPayload(src)) {
        applyForms++;
        if (out === APPLICATION_FORM_PLACEHOLDER) applyFormsDropped++;
        else if (applyLeakSamples.length < 5) applyLeakSamples.push(`  [messages ${m.id}] ${JSON.stringify(src.slice(0, 70))}`);
      } else if (!isSearch && isApplicationFormMessage(src).detected) {
        mentionOnly++;
      }
      // 落とした物は往復の対象外（戻す物が無い）
      if (isApplicationPayload(src)) continue;

      const back = masker.unmask(out);
      if (back !== src) {
        broken++;
        if (brokenSamples.length < 8) brokenSamples.push(`  [messages ${m.id}]\n    元: ${JSON.stringify(src.slice(0, 90))}\n    戻: ${JSON.stringify(back.slice(0, 90))}`);
      }
      if (masker.leftovers(back).length > 0) leftover++;
      for (const e of masker.table()) masked[e.kind]++;
      // 伏せてはいけない物が消えていないか
      for (const [label, re] of KEEP_PATTERNS) {
        if (re.test(src) && !re.test(out)) keepBroken.set(label, (keepBroken.get(label) ?? 0) + 1);
      }
    }
    if (data.length < 1000) break;
  }

  // ② ai_reply_examples（毎回プロンプトに載る他人の会話）
  let exTotal = 0, exBroken = 0;
  for (let page = 0; ; page++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, customer_message, sent_reply")
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) { console.error("ai_reply_examples 取得失敗:", error.message); break; }
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ id: string; conversation_id: string | null; customer_message: string | null; sent_reply: string | null }>) {
      for (const src of [r.customer_message ?? "", r.sent_reply ?? ""]) {
        if (!src) continue;
        exTotal++;
        const masker = createMasker({
          conversationId: r.conversation_id ?? "example",
          customerName: r.conversation_id ? (nameByConv.get(r.conversation_id) ?? null) : null,
          knownNames,
        });
        const out = masker.mask(src);
        if (isFilledSumoraForm(src)) { searchForms++; if (out === APPLICATION_FORM_PLACEHOLDER) searchFormsDropped++; }
        else if (isApplicationPayload(src)) {
          applyForms++;
          if (out === APPLICATION_FORM_PLACEHOLDER) applyFormsDropped++;
          else if (applyLeakSamples.length < 5) applyLeakSamples.push(`  [example ${r.id}] ${JSON.stringify(src.slice(0, 70))}`);
        } else if (isApplicationFormMessage(src).detected) mentionOnly++;
        if (isApplicationPayload(src)) continue;
        if (masker.unmask(out) !== src) {
          exBroken++;
          if (brokenSamples.length < 8) brokenSamples.push(`  [example ${r.id}]\n    元: ${JSON.stringify(src.slice(0, 90))}`);
        }
        for (const e of masker.table()) masked[e.kind]++;
        for (const [label, re] of KEEP_PATTERNS) {
          if (re.test(src) && !re.test(out)) keepBroken.set(label, (keepBroken.get(label) ?? 0) + 1);
        }
      }
    }
    if (data.length < 1000) break;
  }

  console.log(`\n── 往復（マスク → 戻す）`);
  console.log(`  会話の本文      : ${total} 件中 ${broken} 件が元に戻らなかった`);
  console.log(`  事例（他人の会話）: ${exTotal} 件中 ${exBroken} 件が元に戻らなかった`);
  console.log(`  戻した後に仮名が残った: ${leftover} 件`);

  console.log(`\n── 伏せた物の内訳（のべ）`);
  for (const [k, v] of Object.entries(masked)) {
    const label = { name: "お客様の名前", mobile: "携帯番号", email: "メール", birthday: "生年月日", address: "現住所", employer: "勤務先" }[k as MaskKind];
    console.log(`  ${label.padEnd(8, "　")}: ${v}`);
  }

  console.log(`\n── 竹内さんの線: 物件検索のフォーマットは残す / 申込の個人情報は渡さない`);
  console.log(`  物件検索のフォーマット: ${searchForms} 件中 ${searchFormsDropped} 件が落ちた ${searchFormsDropped === 0 ? "✅" : "⚠ 残すべき物が落ちている"}`);
  console.log(`  申込の個人情報        : ${applyForms} 件中 ${applyFormsDropped} 件を落とした ${applyForms === applyFormsDropped ? "✅" : "⚠ 渡ってしまう物がある"}`);
  console.log(`  「申込フォーム」の語だけ: ${mentionOnly} 件は残した（「お送りします」等の普通の会話。落とすと文脈が歪む）`);
  if (applyLeakSamples.length > 0) { console.log("  落ちなかった例:"); for (const s of applyLeakSamples) console.log(s); }

  console.log(`\n── 伏せてはいけない物が消えていないか（誤爆）`);
  if (keepBroken.size === 0) console.log("  誤爆 0 件 ✅（物件名・家賃・間取り・築年数・駅徒歩・物件の住所・固定電話は全部残った）");
  else for (const [k, v] of keepBroken) console.log(`  ⚠ ${k}: ${v} 件で消えた`);

  if (brokenSamples.length > 0) {
    console.log(`\n── 元に戻らなかった例（先頭 ${brokenSamples.length} 件）`);
    for (const s of brokenSamples) console.log(s);
  }

  const ng = broken + exBroken + leftover + keepBroken.size + searchFormsDropped + (applyForms - applyFormsDropped);
  console.log(`\n結果: ${ng === 0 ? "✅ 問題なし（往復・誤爆ともに 0）" : `⚠ 要確認（${ng}）`}`);
  process.exit(ng === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
