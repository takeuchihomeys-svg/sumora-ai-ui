// 「了承の言葉で始まる長い発言」で会社の事実が使われない原因を、生成プロンプトを書き出して比べる（検証用）
//
// 2026-09-23 竹内「穴の部分何が原因なのか成約データ等と比べて徹底的に調査する」
//
// 【穴】同じ「店舗に行けるか」の質問でも
//   短い「店舗に行って直接相談することはできますか？」        → 2/2 で正しく答えた
//   長い「承知いたしました。当日はそちらの店舗へ伺い、…」      → 2/2 で店舗に触れず「ごゆっくりご確認ください」
//   事実はプロンプトに入っているのに使われない＝材料ではなく**場面の読み取り**の問題。
//
// 設計知見「材料を足しても直らない時は、材料全体を書き出して同じ語を言わせている出所を全部数える」
//   → DEBUG_PROMPT_DIR で dynamicBlock を書き出し、2つの場面の**指示の違い**を並べる。
//
// ⚠ 開発サーバーを DEBUG_PROMPT_DIR 付きで起動しておくこと。
// 実行: npx tsx --env-file=.env.local scripts/peek-buried-question-prompt.ts
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const DIR = process.env.DEBUG_PROMPT_DIR ?? path.join(process.cwd(), ".debug-prompt");

const CASES: Array<{ id: string; msg: string }> = [
  { id: "A 短い（成功する）", msg: "店舗に行って直接相談することはできますか？" },
  { id: "B 長い（失敗する）", msg: "承知いたしました。当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います。" },
];

/** プロンプトから「見出し」を抜く（どの指示ブロックが入ったかを比べる） */
const headings = (t: string) => (t.match(/【[^】]{2,40}】/g) ?? []);
/** 指定の語を含む行を抜く */
const linesWith = (t: string, re: RegExp) => t.split("\n").filter((l) => re.test(l)).map((l) => l.trim());

async function main() {
  const { data: conv } = await sb.from("conversations").select("status, customer_name, has_viewed").eq("id", YUMA).maybeSingle();
  const c = (conv ?? {}) as Record<string, unknown>;
  const { data: msgs } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated")
    .eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(20);
  const recentMessages = ((msgs ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({
    sender: String(m.sender), text: String(m.text ?? ""),
    imageUrl: (m.image_url as string | null) ?? undefined,
    createdAt: String(m.created_at), isAix: !!m.is_aix_generated,
  }));

  const dumps: Record<string, string> = {};
  for (const cs of CASES) {
    const before = new Set(fs.existsSync(DIR) ? fs.readdirSync(DIR) : []);
    const body = {
      message: cs.msg, customerMessages: [cs.msg], state: String(c.status ?? "proposing"),
      conversationId: YUMA, customerName: String(c.customer_name ?? "YUMA"),
      hasViewed: !!c.has_viewed, activeTaskTypes: [] as string[],
      recentMessages: [...recentMessages, { sender: "customer", text: cs.msg, createdAt: new Date().toISOString(), isAix: false }],
    };
    let draft = "";
    try {
      const res = await fetch(`${BASE}/api/generate-reply`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const raw = await res.text();
      const nl = raw.indexOf("\n");
      draft = (nl >= 0 ? raw.slice(nl + 1) : raw).replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
    } catch (e) { draft = `【エラー】${e instanceof Error ? e.message : String(e)}`; }
    // 新しく書き出されたファイルを拾う
    await new Promise((r) => setTimeout(r, 1500));
    const after = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => !before.has(f)) : [];
    const file = after.sort().pop();
    dumps[cs.id] = file ? fs.readFileSync(path.join(DIR, file), "utf8") : "";
    console.log(`${"═".repeat(74)}\n■ ${cs.id}`);
    console.log(`  客   : ${cs.msg.slice(0, 70)}`);
    console.log(`  生成 : ${draft.replace(/\n/g, " / ").slice(0, 130)}`);
    console.log(`  プロンプト: ${dumps[cs.id].length}字${file ? `（${file}）` : "（書き出せず）"}`);
  }

  const A = dumps[CASES[0].id], B = dumps[CASES[1].id];
  if (!A || !B) { console.log("\n⚠ プロンプトを書き出せなかった。DEBUG_PROMPT_DIR 付きで dev を起動しているか確認"); return; }

  console.log(`\n${"═".repeat(74)}\n【① 会社の事実は両方に入っているか】`);
  for (const [k, t] of [["A 短い", A], ["B 長い", B]] as const) {
    const has = t.includes("会社として答えが決まっている事実");
    console.log(`   ${k}: ${has ? "✓ 入っている" : "✗ 入っていない"}`);
    if (has) for (const l of linesWith(t, /オンライン専門|来社/)) console.log(`       ${l.slice(0, 96)}`);
  }

  console.log(`\n【② 指示ブロックの違い（Bだけにある＝場面の読み取りが変わった所）】`);
  const hA = new Set(headings(A)), hB = new Set(headings(B));
  const onlyB = [...hB].filter((h) => !hA.has(h));
  const onlyA = [...hA].filter((h) => !hB.has(h));
  console.log(`   Bだけ: ${onlyB.join(" ") || "なし"}`);
  console.log(`   Aだけ: ${onlyA.join(" ") || "なし"}`);

  console.log(`\n【③ 返信の方向・場面（この1行が本文を決める）】`);
  for (const [k, t] of [["A 短い", A], ["B 長い", B]] as const) {
    console.log(`   ${k}:`);
    for (const l of linesWith(t, /返信の方向性|現在の場面|必ず含める内容|ブレインが掴んだ中身/)) console.log(`       ${l.slice(0, 150)}`);
  }

  console.log(`\n【④ お客様の質問として拾えているか】`);
  for (const [k, t] of [["A 短い", A], ["B 長い", B]] as const) {
    const q = linesWith(t, /お客様の質問|customer_questions|質問[:：]/);
    console.log(`   ${k}: ${q.length ? q.map((x) => x.slice(0, 110)).join(" ／ ") : "（質問として拾った行が無い）"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
