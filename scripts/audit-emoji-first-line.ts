// 生成の材料「【😊 絵文字位置ルール（確定）】お客様の1行目に絵文字 → 返信の1行目に絵文字を1つ入れる」の検算（読み取りのみ）
// 2026-09-22 竹内「絵文字を使うタイミングや使わないタイミング。お客さんからのLINEに応じて変える」
//   設計知見「必須にしてよいのは過半数が守っている形だけ」
// 実行: npx tsx --env-file=.env.local scripts/audit-emoji-first-line.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

async function main() {
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const rows: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }> = [];
  for (let p = 0; p < 60; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const by = new Map<string, typeof rows>();
  for (const m of rows) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  let cE = 0, cEfirst = 0, cN = 0, cNfirst = 0, cEany = 0, cNany = 0;
  for (const arr of by.values()) {
    arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].sender !== "customer") continue;
      let k = i; while (k < arr.length && arr[k].sender === "customer") k++;
      const last = arr[k - 1]; const next = arr[k];
      if (!next || next.sender !== "staff" || next.is_aix_generated) { i = k - 1; continue; }
      const t = (next.text ?? "").trim(); if (!t || /^\[画像\]|^https?:\/\//.test(t)) { i = k - 1; continue; }
      const custFirst = ((last.text ?? "").split("\n")[0] ?? "");
      const replyFirst = t.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      if (EMOJI_RE.test(custFirst)) { cE++; if (EMOJI_RE.test(replyFirst)) cEfirst++; if (EMOJI_RE.test(t)) cEany++; }
      else { cN++; if (EMOJI_RE.test(replyFirst)) cNfirst++; if (EMOJI_RE.test(t)) cNany++; }
      i = k - 1;
    }
  }
  console.log(`お客様の1行目に絵文字あり ${cE}組 → 返信の1行目に絵文字 ${pct(cEfirst, cE)} ／ 返信のどこかに ${pct(cEany, cE)}`);
  console.log(`お客様の1行目に絵文字なし ${cN}組 → 返信の1行目に絵文字 ${pct(cNfirst, cN)} ／ 返信のどこかに ${pct(cNany, cN)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
