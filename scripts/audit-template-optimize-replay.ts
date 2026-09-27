// scripts/audit-template-optimize-replay.ts
// AIX の後の一言（テンプレの「✨ AIで最適化」＝ /api/generate-reply のテンプレ最適化・🟣 AIX モード）を、過去の実例で手元の開発サーバに作り直させる再生の道具。
//   2026-09-27 竹内「AIXのあとのひとこと…実際のスタッフが送った文のように質を上げる／YUMA でテスト繰り返していく」
//   ・読むのは scripts/audit-template-adapt.ts の出力（template-adapt-rows.json）。その行の時刻より前の会話25通・直前の AIX の文・テンプレ原文・ピッカーを渡す
//   ・会話 ID を渡さない＝本番の会話・下書き・学習に何も書かない（手本は _replayBefore でその時刻より前の送信に限る＝開発サーバだけ読む）
//   ・呼ぶ先は手元の開発サーバ（LLM_TEST_MODE=deepseek-all で起動＝本文は DeepSeek）。申込以降の会話は対象外なので飛ばす
//   ・会話 ID が無いので、呼び名が DB から引けない会話（表示名が記号だけ等）は「〇〇さん」になる（本番では出ない・再生だけの差）
// 実行: LLM_TEST_MODE=deepseek-all npx next dev（別の端末）→
//       npx tsx --env-file=.env.local scripts/audit-template-optimize-replay.ts --out=<template-adapt-rows.json のあるフォルダ> --label=after [--only=<id の頭8文字,…>] [--ids=<id,…>]
//   出力: <out>/replay-<label>.json（本番の生成・スタッフの送った文・再生の文を並べる）。前後の比べ方は label を変えて2回回し、目で読む
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const OUT = arg("out"); const LABEL = arg("label", "run"); const ONLY = arg("only");
const BASE = "http://localhost:3000";
const DEFAULT_IDS = ["ddd5b1b8-f97e-42db-8011-f407490e1419","1c631b89-697f-466d-a828-a1740e721d75","3f95b92c-ebc9-424b-a52d-51c00797197c","480ee4f3-bddd-4fac-868c-8daf97f5fa7c","04b6eadc-22cb-4bc1-81a5-6f32458137f2","3333caac-5f5b-4b03-a4cb-bd88628e073e","056ee2f8-bfb6-4bae-aea6-bfb550116022","b367955a-fca5-4792-9c36-542e116ebb01","05fd4e29-f694-4d29-b773-0d73e0be793d","6a16832b-c347-4ed2-8a6c-39a6011469f5","bdebcf85-512f-4f1c-a466-f7291c7bb0e6","4c130bc6-a0df-4098-bd68-6323f7c02517","0116dd2c-a3fc-49e8-aaa8-b3d22467b345","9cfe7651-6dd2-44bb-acad-7db7a521090d","c4b5b87f-434e-41b4-99b6-1b23d6f09701"];
const IDS = arg("ids") ? arg("ids").split(",") : DEFAULT_IDS;
import { DRAFT_SKIP_STATUSES as POST_APPLY } from "@/app/lib/conversation-status";
async function readAll(res: Response) { const r = res.body!.getReader(); const d = new TextDecoder(); let s = ""; for (;;) { const { done, value } = await r.read(); if (done) break; s += d.decode(value, { stream: true }); } return s + d.decode(); }
async function main() {
  const rows = JSON.parse(readFileSync(`${OUT}/template-adapt-rows.json`, "utf8")) as any[];
  const res: any[] = [];
  for (const id of IDS) {
    if (ONLY && !ONLY.split(",").includes(id.slice(0, 8))) continue;
    const r = rows.find((x) => x.id === id); if (!r) { console.log("no row", id); continue; }
    if (POST_APPLY.has(r.conversation_status)) { console.log("skip post-apply", id); continue; }
    const { data: msgs } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", r.conversation_id).lt("created_at", r.at).order("created_at", { ascending: false }).limit(25);
    const hist = (msgs ?? []).reverse();
    const recentMessages = hist.map((m: any) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated }));
    const aix = [...hist].reverse().find((m: any) => m.sender === "staff" && m.is_aix_generated && m.text && m.text !== "[画像]" && !/^（室内イメージ）/.test(m.text) && !/^https?:/.test(m.text));
    const { data: tpl } = await sb.from("templates").select("id, category").eq("label", r.template_label).limit(1);
    const t0 = Date.now();
    const resp = await fetch(`${BASE}/api/generate-reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      message: "", state: r.conversation_status ?? "proposing", customerName: r.customer_name ?? "", recentMessages,
      templateText: r.template_text, templateCategory: tpl?.[0]?.category ?? r.template_category, templateLabel: r.template_label, templateId: tpl?.[0]?.id ?? null,
      templateFocusPoints: [], noEmoji: false, soloEntry: false, pendingScheduledMessages: [], vacatingDate: null, staffMessagedToday: false,
      aixPickerMode: r.picker_mode ?? null, aixActionType: r.aix_action_type ?? null, _replayBefore: r.at, _replayExcludeConversationId: r.conversation_id,
      ...(aix ? { aixSourceMessage: aix.text } : {}),
    }), signal: AbortSignal.timeout(180_000) });
    const raw = await readAll(resp);
    const gen = raw.replace(/\n?<<<[A-Z_]+:[\s\S]*?(?:>>>|$)/g, "").trim();
    console.log(`\n### ${r.at.slice(0, 16)} ${r.customer_name} [${r.template_label}] picker=${r.picker_mode} ${Date.now() - t0}ms HTTP ${resp.status}`);
    console.log("--- 新:\n" + gen);
    res.push({ id, at: r.at, customer_name: r.customer_name, label: r.template_label, picker: r.picker_mode, aix_action_type: r.aix_action_type, prod_generated: r.generated, staff_sent: r.sent, edit: r.edit, replay: gen, ms: Date.now() - t0 });
  }
  writeFileSync(`${OUT}/replay-${LABEL}.json`, JSON.stringify(res, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
