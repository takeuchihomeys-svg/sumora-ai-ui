// scripts/audit-followup-yuma.ts
// AIX の後の一言（送信後のバナーのテンプレ → 「✨ AIで最適化」＝ /api/generate-reply の 🟣 AIX モード）を、
// YUMA（テスト用の会話・竹内さん本人）に実際にある AIX の文を材料に、画面と同じ呼び方（makeFollowup＝TemplateModal と同じ body）で作らせて目で読む道具。
//   2026-09-27 竹内「AIXのあとのひとことは…この会話にあった文を生成…実際のスタッフが送った文のように質を上げる／YUMA でテスト繰り返していく」
//   ・送らない（LINE にも messages にも書かない）。テンプレ最適化の generate-reply は会話の ai_draft を書かない
//   ・呼ぶ先は手元の開発サーバ（LLM_TEST_MODE=deepseek-all で起動＝本文は DeepSeek）。生成後に llm_usage_logs の model を見る
//   ・会話は「その AIX を送った直後」の形（その AIX の送信時刻までの YUMA のメッセージ）。ピッカーは画面の picker_mode と同じ値で渡す
//   ・検査（決定論・目で読む前の目印）: 返事の出だし／お待たせ／テンプレに無い約束（お送り・確認・作成させて頂きます）／資料の物件名が入っているか／
//     締めがスタッフの形（お気に召されましたら）か、テンプレの崩れた締め（お気に召されたお部屋ご都合）か
// 実行: npx tsx --env-file=.env.local scripts/audit-followup-yuma.ts [--repeat=2] [--base=http://localhost:3000]
import { createClient } from "@supabase/supabase-js";
import { makeFollowup } from "@/app/lib/customer-sim-staff-run";
import { extractAixPropertyName } from "@/app/lib/template-optimize-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = arg("base", "http://localhost:3000");
const REPEAT = Math.max(1, Number(arg("repeat", "1")) || 1);

type Case = { action: string; pickerMode: string | null; match: RegExp; note: string };
const CASES: Case[] = [
  { action: "estimate_sheet", pickerMode: null, match: /^【エステムコート大阪WEST】/, note: "見積書（1件）の後" },
  { action: "property_recommendation", pickerMode: "新着1件", match: /^🌟プレサンス難波WEST 0205/, note: "物件オススメ（新着1件）の後" },
  { action: "property_recommendation", pickerMode: "継続ピックアップ", match: /^🌟エスリードコート難波ウエスト 206/, note: "物件オススメ（継続ピックアップ＝送った中から推す）の後" },
];

const REPLY_OPENER_RE = /^(?:[^\n]{0,12}さん)?\s*(?:かしこまりました|承知(?:致|いた)しました|とんでもございません|はい[！!、。]|ご連絡ありがとうございます)/;
const PROMISE_RE = /(?:お送り|確認|作成|ピックアップ)(?:させて(?:頂|いただ)きます|次第)/g;

function check(text: string, template: string, aixText: string): string[] {
  const out: string[] = [];
  if (REPLY_OPENER_RE.test(text.trim())) out.push("返事の出だし");
  if (/お待たせ/.test(text)) out.push("お待たせ");
  for (const m of text.match(PROMISE_RE) ?? []) if (!template.includes(m)) out.push(`テンプレに無い約束「${m}」`);
  const name = extractAixPropertyName(aixText) || (/^【([^】]+)】/.exec(aixText.trim())?.[1] ?? "");
  if (name && !text.includes(name)) out.push(`資料の物件名「${name}」が無い`);
  if (/お気に召されたお部屋ご都合/.test(text)) out.push("テンプレの崩れた締め");
  return out;
}

async function main() {
  const { data: conv } = await sb.from("conversations").select("account, customer_name, status").eq("id", CONV).single();
  const started = new Date().toISOString();
  const { data: aixMsgs } = await sb.from("messages").select("text, created_at").eq("conversation_id", CONV).eq("sender", "staff").eq("is_aix_generated", true).order("created_at", { ascending: false }).limit(300);
  for (const c of CASES) {
    const hit = ((aixMsgs ?? []) as Array<{ text: string | null; created_at: string }>).find((m) => c.match.test((m.text ?? "").trim()));
    if (!hit) { console.log(`\n### ${c.note}: YUMA にその AIX が無い（${c.match}）`); continue; }
    const { data: msgs } = await sb.from("messages").select("sender, text, created_at, is_aix_generated, image_url").eq("conversation_id", CONV).lte("created_at", hit.created_at).order("created_at", { ascending: false }).limit(25);
    const hist = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null }>).reverse();
    for (let i = 0; i < REPEAT; i++) {
      const f = await makeFollowup(sb, BASE, { action: c.action, aixText: hit.text ?? "", conversationId: CONV, conv: conv as { account: string | null; customer_name: string | null; status: string | null }, msgs: hist, propertyLabel: null, pickerMode: c.pickerMode });
      const { data: tpl } = f.templateId ? await sb.from("templates").select("text").eq("id", f.templateId).single() : { data: null };
      const flags = f.text ? check(f.text, String((tpl as { text?: string } | null)?.text ?? ""), hit.text ?? "") : ["生成なし"];
      console.log(`\n### ${c.note}（${hit.created_at.slice(0, 16)}・ピッカー ${c.pickerMode ?? "-"}）#${i + 1} テンプレ「${f.label}」 ${f.how ?? ""}${f.skipped ? ` ${f.skipped}` : ""}`);
      console.log(`--- 資料（AIX）:\n${(hit.text ?? "").slice(0, 220)}`);
      console.log(`--- 一言:\n${f.text ?? "（なし）"}`);
      console.log(`--- 目印: ${flags.length ? flags.join("／") : "なし"}`);
    }
  }
  // 生成の相手（本文が DeepSeek か）
  const { data: logs } = await sb.from("llm_usage_logs").select("model, action, env").eq("conversation_id", CONV).gte("created_at", started).limit(200);
  const cnt: Record<string, number> = {};
  for (const l of (logs ?? []) as Array<{ model: string; action: string | null; env: string | null }>) cnt[`${l.env}/${l.action}/${l.model}`] = (cnt[`${l.env}/${l.action}/${l.model}`] ?? 0) + 1;
  console.log("\n生成の相手（llm_usage_logs・この実行の間）:", cnt);
}
main().catch((e) => { console.error(e); process.exit(1); });
