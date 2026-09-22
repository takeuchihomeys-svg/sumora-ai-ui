// ブレインが LLM に送っている本文（伏せ字の後）に、お客様の個人情報が残っていないかを調べる（読み取りのみ）
//
// 2026-09-23 竹内「問題は個人情報を deepseek 側が読み取ること、その点も含めてみてほしい」
//   ブレインの伏せ字は pii-mask.maskPII（戻さない方）。見るのは次の3つに絞る:
//     ① お客様の本名（会話の表示名・物件顧客の名前・申込フォームに書かれた氏名）が残っていないか
//     ② お客様が送った申込フォームの中身（氏名・生年月日・現住所・勤務先・緊急連絡先の**値**）が残っていないか
//     ③ 電話番号・メール・郵便番号
//   ※ 物件の住所・物件番号・台帳の日時は個人情報ではないので数えない（竹内「物件情報はマスキング不要」）
//
// ⚠ 会話には書き込まない（layer=fresh・propertyCustomerId=null）。Claude を1回呼ぶ費用はかかる。
// ⚠ 見つかった実物は伏せて表示する（この出力自体に個人情報を出さない）
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-pii-leak.ts [--n=10]
import { createClient } from "@supabase/supabase-js";
import { isApplicationPayload } from "../app/lib/pii-pseudonym";
import { loadKnownCustomerNames } from "../app/lib/pii-known-names";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const N = Number(arg("n", "10"));
process.env.LLM_ALT_ACTIONS = "";   // 差し替えない（Claude のまま。送る本文だけを見る）

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const captured: Array<{ action: string | null; text: string }> = [];
function installCapture() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url?.startsWith("https://api.anthropic.com/v1/messages") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as { system?: unknown; messages?: Array<{ content?: unknown }> };
        const headers = new Headers(init.headers ?? undefined);
        const flat = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("\n") : "";
        captured.push({ action: headers.get("x-sumora-llm-action"), text: `${flat(body.system)}\n${(body.messages ?? []).map((m) => flat(m.content)).join("\n")}` });
      } catch { /* 読めなければ素通り */ }
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
}

const CONTACT: Array<[string, RegExp]> = [
  ["携帯番号", /(?<!\d)0[789]0[-‐−ー\s]?\d{4}[-‐−ー\s]?\d{4}(?!\d)/g],
  ["メール", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["郵便番号", /〒\s*\d{3}[-‐−ー]?\d{4}/g],
];
/** 申込フォームの項目に**値**が書かれている形（ラベルの後ろに2文字以上の中身） */
const FORM_VALUE_RE = /(氏名|フリガナ|生年月日|現住所|緊急連絡先|勤務先|続柄|年収)[^\n：:]{0,6}[：: 　]+([^\s：:【】\n][^\n]{1,40})/g;
const hide = (s: string) => s.replace(/[0-9０-９]/g, "#").replace(/[一-龯ァ-ヶ][一-龯ァ-ヶー]+/g, (m) => m[0] + "…");

async function main() {
  installCapture();
  const { analyzeConversation } = await import("../app/lib/brain-core");
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const { data: msgs } = await sb.from("messages").select("conversation_id").eq("sender", "customer").gte("created_at", since).order("created_at", { ascending: false }).limit(600);
  const ids = [...new Set(((msgs ?? []) as Array<{ conversation_id: string }>).map((m) => m.conversation_id))].slice(0, N * 3);
  const { data: convs } = await sb.from("conversations").select("id, status, customer_name, property_customer_id, brain_strategy, last_brain_meta").in("id", ids);
  const pool = ((convs ?? []) as Array<{ id: string; status: string | null; customer_name: string | null; property_customer_id: string | null; brain_strategy: unknown; last_brain_meta: unknown }>)
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, N);

  const allNames = (await loadKnownCustomerNames()).map((s) => s.trim()).filter((s) => s.length >= 3);
  console.log(`=== ブレイン（毎回の分析）が送る本文を ${pool.length}会話ぶん調べる（他のお客様の名前 ${allNames.length}件とも照合）===\n`);
  let otherNameLeak = 0; let nameLeak = 0, formLeak = 0, contactLeak = 0, withForm = 0;
  for (const c of pool) {
    // この会話のお客様の本名の候補（表示名・物件顧客の名前・申込フォームに書かれた氏名）
    const names = new Set<string>();
    if (c.customer_name) names.add(String(c.customer_name).trim());
    if (c.property_customer_id) {
      const { data: pc } = await sb.from("property_customers").select("name").eq("id", c.property_customer_id).maybeSingle();
      const nm = (pc as { name?: string | null } | null)?.name;
      if (nm) { names.add(nm.trim()); for (const part of nm.split(/[\s　]+/)) if (part.length >= 2) names.add(part); }
    }
    const { data: recent } = await sb.from("messages").select("sender, text").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(15);
    const recentMsgs = ((recent ?? []) as Array<{ sender: string; text: string | null }>);
    const formMsgs = recentMsgs.filter((m) => isApplicationPayload(m.text ?? ""));
    if (formMsgs.length) withForm++;
    for (const m of formMsgs) for (const mm of (m.text ?? "").matchAll(FORM_VALUE_RE)) if (mm[1] === "氏名" && mm[2]) names.add(mm[2].split(/[\s　]+/)[0]);

    captured.length = 0;
    try {
      await analyzeConversation(c.id, false, c.status, null, "shadow", {
        mode: "incremental", layer: "fresh",
        strategy: (c.brain_strategy ?? null) as never, prevMeta: (c.last_brain_meta ?? undefined) as never,
        customerName: c.customer_name ?? undefined,
      });
    } catch (e) { console.log(`   ⚠ ${c.id.slice(0, 8)} 分析できず: ${e instanceof Error ? e.message.slice(0, 60) : e}`); }
    const brainCalls = captured.filter((x) => x.action === "brain_fresh" || x.action === "brain_full");
    const text = (brainCalls.length ? brainCalls : captured).map((x) => x.text).join("\n");
    if (brainCalls.length === 0) console.log("     ⚠ ブレインの呼び出しを捕まえられず（他の呼び出しで代用）");

    const nameHits = [...names].filter((n) => n.length >= 2 && text.includes(n));
    const formHits = [...new Set((text.match(FORM_VALUE_RE) ?? []))].filter((s) => !/\[回答済み・非表示\]|\[電話番号非表示\]|[（(]|等を|なし'|情報|項目|ラベル|記入欄$/.test(s));
    const contactHits: string[] = [];
    for (const [label, re] of CONTACT) { const m = text.match(re); if (m) contactHits.push(`${label}${m.length}`); }
    const own = new Set([...names]);
    const otherHits = allNames.filter((n) => !own.has(n) && text.includes(n));
    if (otherHits.length) otherNameLeak++;
    if (nameHits.length) nameLeak++;
    if (formHits.length) formLeak++;
    if (contactHits.length) contactLeak++;
    if (formHits.length) { const i = text.indexOf(formHits[0]); console.log(`     前後: ${hide(text.slice(Math.max(0, i - 60), i + 60))}`); }
    console.log(`${c.id.slice(0, 8)} ${String(c.status ?? "").padEnd(10)} 送信${String(text.length).padStart(6)}字 ／ 直近15通に申込フォーム ${formMsgs.length}通 ／ 本名 ${nameHits.length ? `残る(${nameHits.map((n) => hide(n)).join("・")})` : "なし"} ／ 項目の値 ${formHits.length ? `残る(${formHits.slice(0, 2).map((s) => hide(s.slice(0, 26))).join(" ／ ")})` : "なし"} ／ 連絡先 ${contactHits.length ? contactHits.join("・") : "なし"} ／ 他のお客様の名前 ${otherHits.length ? `残る(${otherHits.slice(0, 3).map((n) => hide(n)).join("・")})` : "なし"}`);
  }
  console.log(`\n=== まとめ（${pool.length}会話・直近15通に申込フォームがあったのは ${withForm}会話）===`);
  console.log(`   お客様の本名が残った会話: ${nameLeak}`);
  console.log(`   申込フォームの項目の値が残った会話: ${formLeak}`);
  console.log(`   携帯番号・メール・郵便番号が残った会話: ${contactLeak}`);
  console.log(`   他のお客様の名前（手本・ナレッジ由来）が残った会話: ${otherNameLeak}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
