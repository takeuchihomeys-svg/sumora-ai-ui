// 作業メモの見出しを落とす行（meta-narration）が、スタッフの実送信に当たらないかの監査（誤削除0の確認）
// 2026-09-22 YUMA の下書き
//   ①「かしこまりました！！\n以下、返信案です。\n\n〜」（2行目に入った見出し）
//   ②「【今回の判定】\n・直前スタッフ送信＝物件送付済み…\n・見積書解禁条件（…）を満たすので…\n\nはい😊！！…」（判定の塊）
// 実行: npx tsx --env-file=.env.local scripts/audit-meta-heading.ts
import { createClient } from "@supabase/supabase-js";
import { META_BLOCK_HEADING_RE } from "../app/lib/meta-narration";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const LINE_RE = /^\s*(?:以下|下記|こちら)(?:、|が|は)?(?:の)?(?:返信案|回答案|修正版|修正案|返信文|下書き)(?:です|となります|になります)?[。．：:]?\s*$/m;

async function scan(keywords: string[], test: (t: string) => boolean): Promise<{ n: number; hit: string[] }> {
  let n = 0;
  const hit: string[] = [];
  for (const kw of keywords) {
    for (let p = 0; p < 30; p++) {
      const { data } = await sb.from("messages").select("text").eq("sender", "staff").ilike("text", kw).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as Array<{ text: string | null }>;
      n += r.length;
      for (const x of r) if (test(x.text ?? "")) hit.push((x.text ?? "").slice(0, 80).replace(/\s+/g, " "));
      if (r.length < 1000) break;
    }
  }
  return { n, hit };
}

async function main() {
  const a = await scan(["%返信案%", "%修正版%", "%回答案%", "%返信文%", "%下書き%", "%修正案%"], (t) => LINE_RE.test(t));
  console.log(`① 見出し「以下、返信案です」: スタッフ送信（語を含む）${a.n}件 ／ 当たる ${a.hit.length}件`);
  for (const h of a.hit) console.log("  ", h);
  const b = await scan(["%【%】%"], (t) => t.split("\n").some((l) => META_BLOCK_HEADING_RE.test(l)));
  console.log(`② 判定の見出し「【今回の判定】」等: スタッフ送信（【】を含む）${b.n}件 ／ 当たる ${b.hit.length}件`);
  for (const h of b.hit) console.log("  ", h);
  const SCENE_RE = /^\s*【[^】\n]{0,80}(?:場面|状況)(?:での|の|への|に対する)?(?:返信|返答|回答)(?:案|文)?】\s*$/;
  const c = await scan(["%【%】%"], (t) => t.split("\n").some((l) => SCENE_RE.test(l)));
  console.log(`③ 場面の見出し「【〜場面での返信】」: スタッフ送信（【】を含む）${c.n}件 ／ 当たる ${c.hit.length}件`);
  for (const h of c.hit) console.log("  ", h);
}
main().catch((e) => { console.error(e); process.exit(1); });
