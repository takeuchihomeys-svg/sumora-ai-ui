// scripts/audit-portal-ui-text.ts — お客様が送ったポータル画面の書き起こしの UI 文（内見予約・空室状況を知りたい・写真をもっと見たい・初期費用を知りたい・お問い合わせ・〇回以上見た）が、
//   下書き・ブレインでお客様の依頼として扱われた番を数える（読むだけ・LLM なし）。#31（10/28 竹内さん・ひめの）
//   印: お客様の言葉（画像の通を除く）にその話題が無いのに、下書きがその話題（内覧・写真・空き状況・初期費用）に答えた／ブレインがその AIX を選んだ
// 実行: npx tsx --env-file=.env.local scripts/audit-portal-ui-text.ts [--days=60]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "60");
const TOPICS: Array<{ k: string; ui: RegExp; own: RegExp; draft: RegExp; aix: RegExp }> = [
  { k: "内覧", ui: /内見予約|見学予約/, own: /内見|内覧|見学|見に行|見たい/, draft: /内覧|内見|ご案内/, aix: /viewing_invite|meeting_place/ },
  { k: "写真", ui: /写真をもっと見たい|写真を見る/, own: /写真|画像|室内|中の様子/, draft: /写真|室内/, aix: /room_photo|photo/ },
  { k: "空き状況", ui: /空室状況を知りたい|空き状況を知りたい|最新の空き状況/, own: /空いて|空き|募集|空室|まだあり|残って|入居でき/, draft: /募集状況|空き状況|空室/, aix: /property_check_result/ },
  { k: "初期費用", ui: /初期費用を知りたい/, own: /初期費用|費用|見積|いくら|お金|安く|割引/, draft: /御見積書|初期費用/, aix: /estimate_sheet|cost_/ },
];
(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const turns: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, draft_first, brain_action").gte("customer_turn_at", since).order("id").range(from, from + 999);
    if (r.error) throw new Error(r.error.message);
    turns.push(...(r.data ?? []));
    if ((r.data ?? []).length < 1000) break;
  }
  const cnt: Record<string, { ui: number; draft: number; aix: number; ids: number[] }> = Object.fromEntries(TOPICS.map((t) => [t.k, { ui: 0, draft: 0, aix: 0, ids: [] }]));
  let withPortal = 0;
  for (const t of turns as Array<{ id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; draft_first: string | null; brain_action: string | null }>) {
    const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", t.conversation_id).eq("sender", "customer").gte("created_at", t.customer_turn_at).lte("created_at", t.customer_last_at ?? t.customer_turn_at);
    const texts = ((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "");
    const img = texts.filter((x) => /^\s*\[画像\]/.test(x)).join("\n"), own = texts.filter((x) => !/^\s*\[(?:画像|動画|ファイル)\]/.test(x)).join("\n");
    if (!/【物件の画面（ポータル）】|SUUMO|suumo|HOME'?S|アットホーム/.test(img)) continue;
    withPortal++;
    for (const tp of TOPICS) {
      if (!tp.ui.test(img) || tp.own.test(own)) continue;
      const c = cnt[tp.k]; c.ui++;
      if (tp.draft.test(t.draft_first ?? "")) { c.draft++; if (c.ids.length < 12) c.ids.push(t.id); }
      if (tp.aix.test(t.brain_action ?? "")) c.aix++;
    }
  }
  console.log(`見張りの番 ${turns.length}・ポータルの画面の画像がある番 ${withPortal}`);
  for (const [k, c] of Object.entries(cnt)) console.log(`  ${k}: UI 文あり・お客様の言葉に無い ${c.ui}番 → 下書きがその話題 ${c.draft}・ブレインがその AIX ${c.aix}（番 ${c.ids.join(",")}）`);
  process.exit(0);
})();
