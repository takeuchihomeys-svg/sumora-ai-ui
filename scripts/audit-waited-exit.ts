// AIX の出口 replaceWaitedOpening（挨拶行の「お待たせ致しました」だけを差し替える）を、AIX の実送信（ai_reply_examples の aix_action あり・
// お待たせを含む全部）に当てて、①「お待たせ」が残らないか ②「お待たせ」以外の文字が消えていないか（誤削除0）を数え、前後を目で読む（読み取りのみ）。
// 2026-09-27 竹内さん決定「AIX でも『お待たせ致しました』は使わない」の出口の線引き。結果: 712通×（挨拶あり・本日挨拶済み）で 残り0・
//   差分2（どちらも「ニアさん、お待たせ…」の名前の後ろの「、」＝お待たせの句の一部）。旧 stripWaited は名前の呼びかけまで消していた（920/1424）。
// 実行: npx tsx --env-file=.env.local scripts/audit-waited-exit.ts
import { createClient } from "@supabase/supabase-js";
import { replaceWaitedOpening } from "../app/lib/waited-scope";
import { stripWaited } from "../app/lib/greeting";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const G = "お世話になっております！！";
const norm = (s: string) => s.replace(/\s+/g, "").replaceAll(G, "");
const dropWaited = (s: string) => s.replace(/(?:大変)?お待たせ(?:致|いた)?しました(?:😊|😌|🙇‍♀️|🙇)*[！!。]*/gu, "");
async function main() {
  const out: any[] = [];
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from("ai_reply_examples").select("sent_reply, aix_action").not("aix_action", "is", null).ilike("sent_reply", "%お待たせ%").order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  let bad = 0, left = 0, oldBad = 0; const samples: string[] = [];
  for (const g of [G, ""]) {
    for (const r of out) {
      const t = String(r.sent_reply);
      const { text } = replaceWaitedOpening(t, g);
      if (/お待たせ(?:致|いた)?しました/.test(text)) { left++; if (samples.length < 8) samples.push("LEFT " + text.split("\n").find((l) => /お待たせ/.test(l))); continue; }
      if (norm(text) !== norm(dropWaited(t))) { bad++; if (samples.length < 16) samples.push(`BAD g=${!!g}\n<<${t.slice(0, 200)}\n>>${text.slice(0, 200)}`); }
      // 旧 stripWaited は何を落とすか（比較用）
      const o = stripWaited(t).text; if (norm(o) !== norm(dropWaited(t))) oldBad++;
    }
  }
  console.log({ rows: out.length, bad, left, oldStripLosesName: oldBad });
  samples.forEach((s) => console.log(s));
  // 目で読む: 形ごとに3通ずつ前後
  const pick = out.filter((_, i) => i % 90 === 0).slice(0, 8);
  for (const r of pick) {
    const t = String(r.sent_reply);
    console.log(`\n=== [${r.aix_action}] 前\n${t.split("\n").slice(0, 4).join("\n")}\n--- 後（挨拶あり）\n${replaceWaitedOpening(t, G).text.split("\n").slice(0, 4).join("\n")}\n--- 後（本日挨拶済み）\n${replaceWaitedOpening(t, "").text.split("\n").slice(0, 4).join("\n")}`);
  }
}
main();
