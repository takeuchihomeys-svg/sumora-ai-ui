// scripts/yuma-pickup-renovation-note-test.ts — 物件ピックアップの②（束の説明）に「束と要望の合う／合わない」の注記が効くかを、注記の前後で比べる（LLM の試し・会話は YUMA の名札）
// 2026-10-07 竹内（Ryoichi kiritsuke 10/05「築浅またはリノベのお部屋」・束 9部屋にリノベ済み 0・築28/築30 の2部屋）
//   本物の /api/aix/action の構成（数千字）は使わず、②に効く材料（希望条件・注記・型）だけの小さな指示で比べる＝注記の効きの目安。
//   束は本番の Ryoichi の 9部屋（property_pickups 3451〜3460・読むだけ）。お客様の名前は「YUMA」に置き換える。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-pickup-renovation-note-test.ts [回数]
//       LLM_TEST_FINAL_CLAUDE=1 npx tsx --env-file=.env.local scripts/yuma-pickup-renovation-note-test.ts 1
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
const N = parseInt(process.argv[2] ?? "3", 10);
const IDS = [3451, 3452, 3453, 3457, 3454, 3455, 3456, 3458, 3460];
const CONDITIONS = "エリア: 堺市堺区\n間取り: 2LDK以上\n家賃: 8万円〜13万円以内\n入居: 11月末\nその他: 築浅かリノベ物件";
// 旧（HEAD 17cc6b89）の注記: 「以上」付きの間取りは読めず・リノベは照らさない
const OLD_NOTE = "【今回お送りする9部屋とお客様のご要望（資料から決めた事実・この通りに書く）】\n・合う（9部屋とも）: 家賃13万円以内\n・部屋で違う・資料で分からない（文に書かない）: 築浅\n→ ②のピックアップ行に入れる要望は「合う」の物だけ（「合わない」「分からない」要望を「〜のお部屋」と合う物のように書かない）。";

const SYSTEM = `あなたは賃貸仲介スモラのスタッフです。お客様に物件ピックアップ（複数の物件資料の画像）を送る時の LINE の文を作ります。
構成: ①お客様名の行（「YUMAさん」）②ピックアップ行「〔エリア〕周辺全域から〔お客様の希望条件（最大2つ）〕のお部屋ピックアップさせて頂きました😊！！」③締め「お手隙の際にご査収ください😌！！」
スタッフの実送信の例:
「YUMAさん\\n\\n堺区周辺全域からYUMAさんにオススメできる2LDK以上のお部屋をピックアップさせて頂きました😊！！\\n\\nお手隙の際にご査収ください😌！！」
「YUMAさん\\n\\n瓦屋町周辺全域から築浅で初期費用を抑えられるお部屋ピックアップさせて頂きました！！\\n\\nお手隙の際にご査収ください😌！！」
出力は {"message":"…"} の JSON だけ。`;

(async () => {
  h = await setupLlmTest("yuma-pickup-renovation-note");
  const { createClient } = await import("@supabase/supabase-js");
  const { parsePickupFact } = await import("../app/lib/pickup-send-facts");
  const { bundleWantsFit, buildBundleFitNote, customerWantsForFit, findUnmetWantClaims, pickupFitInputFromRow } = await import("../app/lib/pickup-wants-fit");
  const { readAixMessageJson } = await import("../app/lib/aix-message-json");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await sb.from("property_pickups").select("id, property_name, summary_text, image_lines, pdf_text, terms, equipment").in("id", IDS);
  const rows = IDS.map((id) => (data ?? []).find((r) => r.id === id)).filter(Boolean) as Array<Parameters<typeof pickupFitInputFromRow>[0] & { summary_text: string | null; image_lines: string[] | null }>;
  const fit = bundleWantsFit(rows.map((r) => pickupFitInputFromRow(r, parsePickupFact(r), null)), customerWantsForFit(CONDITIONS));
  const NEW_NOTE = buildBundleFitNote(fit);
  console.log(`新しい注記:\n${NEW_NOTE}\n`);
  h.assertYuma(YUMA, "物件ピックアップの文の試し");
  const isClaude = process.env.LLM_TEST_FINAL_CLAUDE === "1";
  // 「注記なし」＝10/05 当時（束の注記はまだ無く、構成の「希望条件を文中に織り込む」だけ）
  const variants: Array<[string, string]> = isClaude ? [["新", NEW_NOTE]] : [["注記なし", ""], ["旧", OLD_NOTE], ["新", NEW_NOTE]];
  for (const [label, note] of variants) {
    for (let i = 0; i < N; i++) {
      const user = `【お客様の希望条件（②で使うのは最大2つ・希望条件を文中に織り込む）】\n${CONDITIONS}\n\n${note}\n\n上の材料で、今回の9部屋のピックアップの文を作ってください。`;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "x-sumora-llm-action": "property_send", "x-sumora-llm-conversation": YUMA },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 400, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      });
      const j = await res.json() as { content?: Array<{ type: string; text?: string }>; error?: unknown };
      const raw = j.content?.find((b) => b.type === "text")?.text ?? JSON.stringify(j.error ?? j);
      const text = readAixMessageJson(raw).text || raw;
      const reno = /リノベ|リフォーム/.test(text);
      const asa = /築浅|新築/.test(text);
      console.log(`── ${label} ${i + 1}回目  リノベ:${reno ? "書いた（×）" : "なし"} 築浅:${asa ? "書いた（×・2部屋外れ）" : "なし"} 2LDK以上:${/2LDK以上/.test(text) ? "あり" : "なし"}\n${text}\n[出口] ${findUnmetWantClaims(text, fit) ?? "注意なし"}\n`);
    }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
