// scripts/audit-property-name-guard.ts
// 2026-09-19 竹内（ゆうこ事例）「変に物件名を出さないようにする」
//
// 「受け止めの文から物件名を落とす」判定を、本番の
//   ① スタッフ実送信（正解）に当てて、落ちてしまう文が無いか＝誤削除
//   ② 今ある下書き（入力欄に出ている物）に当てて、実際に何件直るか
// を数える。判定（app/lib/property-name-guard.ts）を変えたら必ず流す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-property-name-guard.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { guardPropertyNames, collectPropertyNames, hasFixedViewing } from "../app/lib/property-name-guard";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);
const short = (s: string, n = 90) => s.replace(/\s+/g, " ").slice(0, n);

type Msg = { conversation_id: string; sender: string; text: string; created_at: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const all: Msg[] = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await sb
      .from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).not("text", "is", null)
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...(data as Msg[]));
    if (data.length < 1000) break;
  }
  console.log(`直近 ${DAYS} 日のメッセージ ${all.length} 通\n`);

  // 会話ごとに並べ、返信の直前のお客様の連投を customerTurn として渡す（本番と同じ材料）
  const byConv = new Map<string, Msg[]>();
  for (const m of all) {
    const list = byConv.get(m.conversation_id) ?? [];
    list.push(m);
    byConv.set(m.conversation_id, list);
  }
  let checked = 0;
  const hits: Array<{ at: string; before: string; after: string; removed: string[]; unknown: string[] }> = [];
  for (const list of byConv.values()) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender === "customer") continue;
      // 直前のお客様の連投
      const turn: string[] = [];
      for (let j = i - 1; j >= 0 && list[j].sender === "customer"; j--) turn.unshift(list[j].text);
      // 会話に出ている物件名（この通より前の発言から。本番の generate-reply と同じ材料）
      const prior = list.slice(0, i);
      const known = collectPropertyNames(prior.map((x) => x.text));
      // 内覧が既に決まっているか（本番と同じ関数）
      const fixed = hasFixedViewing(prior.filter((x) => x.sender !== "customer").map((x) => x.text));
      checked++;
      const r = guardPropertyNames({ text: m.text, knownNames: known, customerTurn: turn.join("\n"), viewingFixed: fixed });
      if (r.removed.length > 0) hits.push({ at: m.created_at, before: m.text, after: r.text, removed: r.removed, unknown: r.unknown });
    }
  }
  console.log(`① スタッフ実送信 ${checked} 通 → 物件名が落ちた ${hits.length} 通`);
  for (const h of hits.slice(0, 20)) {
    console.log(`   ${new Date(h.at).toLocaleDateString("ja-JP")}  落とした: ${h.removed.join("・")}${h.unknown.length ? `（会話に無い: ${h.unknown.join("・")}）` : "（絞り込みの取り違え）"}`);
    console.log(`     前: ${short(h.before)}`);
    console.log(`     後: ${short(h.after)}`);
  }
  console.log("   ※ ここに出た文が「物件名があって当然の文」なら判定が広すぎる。0 か、竹内さんが手で消した型だけが正常\n");

  const { data: drafts, error } = await sb
    .from("conversations").select("customer_name, ai_draft").not("ai_draft", "is", null).limit(1000);
  if (error) throw error;
  const dh = (drafts ?? []).filter((d) => d.ai_draft && guardPropertyNames({ text: d.ai_draft }).removed.length > 0);
  console.log(`② 今ある下書き ${drafts?.length ?? 0} 件 → 直る ${dh.length} 件`);
  for (const d of dh.slice(0, 10)) console.log(`   ${d.customer_name}  ${short(d.ai_draft!)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
