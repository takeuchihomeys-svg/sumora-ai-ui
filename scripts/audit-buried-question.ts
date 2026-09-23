// 「質問が含まれているのに、了承・検討中と分類されて質問に答えない」場面を実データで測る（読み取りのみ）
//
// 2026-09-23 竹内「穴の部分何が原因なのか成約データ等と比べて徹底的に調査する」
//
// 【分かっている原因】生成プロンプトを書き出して比べた（scripts/peek-buried-question-prompt.ts）:
//   同じ「店舗に行けるか」でも
//     短い「店舗に行って直接相談することはできますか？」
//       → 場面=質問回答 ／ 必ず含める内容=**直接回答** → 正しく答えた
//     長い「承知いたしました。当日はそちらの店舗へ伺い、ご相談させていただきながら…」
//       → 場面=**検討中フォロー** ／ 必ず含める内容=**急かさない受け止め＋随時ピックアップ宣言**
//       → 質問に答えることが必須から外れ、しかも「ご来店の際にほかのお部屋も…」と**店舗訪問を受け入れた**
//   ＝ 会社の事実は両方のプロンプトに入っていた。落ちているのは**場面の読み取り**。
//
// 【ここで測ること】
//   ① お客様の発言に質問が含まれているのに、質問以外（了承・検討中・ネガ等）に分類される割合
//   ② その時スタッフは実送信で質問に答えているか（＝答えるのが正しいのか）
//   ③ 成約側の会話とそれ以外で違うか
//   ④ 実物を目で読む
//
// 実行: npx tsx --env-file=.env.local scripts/audit-buried-question.ts [DAYS=120] [SHOW=8]
import { createClient } from "@supabase/supabase-js";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../app/lib/reply-context";
import { matchCompanyFacts } from "../app/lib/company-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();
const WON = new Set(["closed_won", "contract", "approved", "screening", "applying"]);

/** 質問が含まれているか（末尾でなくてもよい＝埋もれた質問も拾う） */
const HAS_QUESTION = /[?？]|(ますか|ですか|でしょうか|ましょうか|かな|かね|教えて|できます|可能です|いくら|何時|いつ|どこ|どう(やって|すれば)|ありますか)/;
/** 了承・お礼で始まっているか（これが場面の読み取りを倒す） */
const STARTS_ACK = /^(承知|かしこまり|了解|わかりました|分かりました|ありがとう|はい|ok|OK|大丈夫)/;

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const SHOW = Number(process.env.SHOW ?? 8);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
  const msgs: Msg[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[]; msgs.push(...r); if (r.length < 1000) break;
  }
  const { data: convData } = await sb.from("conversations").select("id, status").limit(5000);
  const statusOf = new Map(((convData ?? []) as Array<{ id: string; status: string | null }>).map((c) => [c.id, (c.status ?? "").trim()]));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }

  type Case = { conv: string; cust: string; staffText: string; kind: string; won: boolean; answered: boolean; facts: string[] };
  const cases: Case[] = [];
  for (const [conv, list] of byConv) {
    const seq = list.filter((m) => (m.text ?? "").trim() && m.text !== "[画像]");
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].sender !== "customer") continue;
      const cust = seq[i].text ?? "";
      if (!HAS_QUESTION.test(cust)) continue;
      let j = i - 1; while (j >= 0 && seq[j].sender === "customer") j--;
      if (j < 0) continue;
      const staffText = seq[j].text ?? "";
      const staff = classifyLastStaffTurn(staffText, { lastStaffAt: seq[j].created_at });
      const sub = analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
      const customer = classifyCustomerResponse(sub, staff, {});
      // その次のこちらの返信（スタッフが質問に答えたか）
      let k = i + 1; while (k < seq.length && seq[k].sender === "customer") k++;
      const reply = k < seq.length ? (seq[k].text ?? "") : "";
      // 質問の内容語が返信に現れていれば「答えた」とみなす（粗い判定）
      const words = (cust.match(/[一-龥]{2,}|[ァ-ヶー]{3,}/g) ?? [])
        .filter((w) => !/^(承知|了解|ありがとう|宜敷|よろしく|お願い|致します|思います|ござい|いただ|頂き)/.test(w));
      const answered = words.length > 0 && words.some((w) => reply.includes(w));
      cases.push({
        conv: conv.slice(0, 8), cust: one(cust), staffText: one(staffText),
        kind: String((customer as { kind?: string }).kind ?? "?"),
        won: WON.has(statusOf.get(conv) ?? ""), answered,
        facts: matchCompanyFacts(cust).map((f) => f.id),
      });
    }
  }
  console.log(`直近${days}日で「質問を含むお客様の発言」${cases.length}件\n`);

  console.log(`① 分類（質問を含むのに何と読まれているか）`);
  const kinds = [...new Set(cases.map((c) => c.kind))].sort((a, b) => cases.filter((c) => c.kind === b).length - cases.filter((c) => c.kind === a).length);
  for (const k of kinds) {
    const xs = cases.filter((c) => c.kind === k);
    console.log(`   ${k.padEnd(18)} ${String(xs.length).padStart(5)}件（${pct(xs.length, cases.length).padStart(6)}）／ スタッフが答えた ${pct(xs.filter((x) => x.answered).length, xs.length)}`);
  }

  const buried = cases.filter((c) => c.kind !== "question" && STARTS_ACK.test(c.cust));
  console.log(`\n② 了承・お礼で始まり、質問を含み、質問以外に分類された（＝埋もれた質問）`);
  console.log(`   ${buried.length}件（質問を含む発言の ${pct(buried.length, cases.length)}）`);
  console.log(`   そのうちスタッフが実送信で答えている: ${pct(buried.filter((c) => c.answered).length, buried.length)}`);
  console.log(`   → スタッフが答えているなら、AI も答えるべき場面`);

  console.log(`\n③ 成約側かどうか`);
  for (const [name, xs] of [["成約側", buried.filter((c) => c.won)], ["それ以外", buried.filter((c) => !c.won)]] as const) {
    if (xs.length < 5) continue;
    console.log(`   ${name.padEnd(8)} ${String(xs.length).padStart(4)}件 ／ スタッフが答えた ${pct(xs.filter((x) => x.answered).length, xs.length)}`);
  }

  const withFacts = buried.filter((c) => c.facts.length > 0);
  console.log(`\n④ そのうち「会社として答えが決まっている事実」が当たるもの: ${withFacts.length}件`);
  console.log(`   ＝ 事実を渡しているのに場面の読み取りで落ちる可能性がある場面`);

  console.log(`\n⑤ 実物（${SHOW}件・目で読む）`);
  for (const c of buried.slice(0, SHOW)) {
    console.log(`\n   ── ${c.conv} 分類=${c.kind}${c.facts.length ? ` 事実=${c.facts.join(",")}` : ""} スタッフが答えた=${c.answered ? "はい" : "いいえ"}`);
    console.log(`      客   : ${c.cust.slice(0, 96)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
