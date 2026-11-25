// scripts/audit-route-backplan-miss.ts — 逆算の計画の この先 の外れを1番ずつ分け、竹内さん本人の先読み（文の中の仕込みの言葉）と比べる（台帳 #745・読むだけ・LLM なし）
// 2026-11-26 作業員A（竹内さん「２番手先のあたり弱い原因は？ちゃんと地図で竹内のようにできないのか」・統括役の頼み）:
//   外れの分け（上から順に当てる）:
//     ③ 測り方: 次に駅が変わるまで 14日より長い・その会話の本線の番が 3未満
//     ② お客様ごとの事情: 番と変わり目の間に分かれ道の番（条件変更・審査の相談・入居時期が先・持ち込み 等）がある
//     ① 地図に道が無い: 前へ進んだが、地図の1本道の駅を飛ばした（内覧なし・見積→申込・提案→見積 等）
//     ④ お客様の返事で道が変わった: 後ろの駅へ戻った・同じ段の別の駅へ動いた
//   竹内さんの先読み: その番の竹内さんの最初の文の仕込みの言葉（内覧→内覧調整・御見積→見積・申込／抑え→申込準備・ピックアップ→提案中）から狙っていた先の駅を読み、
//     実際の変わり目と地図の この先 のどちらに近いか（竹内さんの先読みとの一致）
// 実行: npx tsx --env-file=.env.local scripts/audit-route-backplan-miss.ts --from=<照らしの json>
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MAIN_ROUTE, type RouteNodeId } from "../app/lib/apply-route-map";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { conv: string; at: string; node: string | null; branch: string | null };
const all = JSON.parse(readFileSync(arg("from"), "utf8")) as Row[];
const byConv = new Map<string, Row[]>();
for (const r of all) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), r]);
const idx = (n: string) => MAIN_ROUTE.indexOf(n as RouteNodeId);
const PLANT: Array<[RegExp, RouteNodeId]> = [
  [/お申込|申込で(?:お部屋を)?抑え|お部屋を抑え|仮押さえ|申込の(?:ご案内|フォーマット)/, "apply_prep"],
  [/ご内覧|内見|内覧(?:頂|いただ|でき|も|の)/, "viewing_arrange"],
  [/御見積|お見積|見積書/, "estimate"],
  [/ピックアップ|お送りさせて頂きます|新着/, "proposing"],
];
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });

(async () => {
  type Out = { conv: string; at: string; node: string; ahead: string[]; changes: string[]; cls1: string | null; cls2: string | null; plant: string | null };
  const outs: Out[] = [];
  for (const xs0 of byConv.values()) {
    const xs = [...xs0].sort((a, b) => a.at.localeCompare(b.at));
    const main = xs.filter((r) => r.node && !r.branch && idx(r.node) >= 0);
    for (const r of main) {
      const node = r.node!;
      const k = idx(node);
      const ahead = MAIN_ROUTE.slice(k + 1, k + 3) as string[];
      const after = main.filter((x) => x.at > r.at);
      const changes: string[] = []; const changeAt: string[] = [];
      for (const x of after) { const prev = changes.length ? changes[changes.length - 1] : node; if (x.node !== prev && changes.length < 2) { changes.push(x.node!); changeAt.push(x.at); } }
      const classify = (pos: 0 | 1): string | null => {
        const want = ahead[pos], got = changes[pos];
        if (!want || !got) return null;
        if (got === want) return "当たり";
        const until = changeAt[pos];
        if (main.length < 3 || Date.parse(until) - Date.parse(r.at) > 14 * 86_400_000) return "③測り方";
        if (xs.some((x) => x.branch && x.at > r.at && x.at <= until)) return "②お客様ごとの事情";
        const from = pos === 0 ? node : changes[0];
        if (idx(got) > idx(from)) return "①地図に道が無い（駅を飛ばした）";
        return "④お客様の返事で道が変わった（戻った・別の駅）";
      };
      outs.push({ conv: r.conv, at: r.at, node, ahead, changes, cls1: classify(0), cls2: classify(1), plant: null });
    }
  }
  // 竹内さんの先読み: 番の後の竹内さんの最初の文（会話の頭8字で会話を引く）
  const convIds = new Map<string, string>();
  for (const c of new Set(outs.map((o) => o.conv))) {
    const { data } = await sb.from("conversations").select("id").like("id", `${c}%`).limit(1);
    const id = (data?.[0] as { id?: string } | undefined)?.id; if (id) convIds.set(c, id);
  }
  for (const o of outs) {
    const id = convIds.get(o.conv); if (!id) continue;
    const { data } = await sb.from("messages").select("text, created_at, staff_writer, is_aix_generated").eq("conversation_id", id).eq("sender", "staff").gte("created_at", new Date(Date.parse(o.at) - 60_000).toISOString()).order("created_at").limit(3);
    const txt = ((data ?? []) as Array<{ text: string | null; is_aix_generated: boolean | null }>).filter((m) => !m.is_aix_generated).map((m) => m.text ?? "").join("\n");
    const hits = PLANT.filter(([re]) => re.test(txt)).map(([, n]) => n).filter((n) => idx(n) > idx(o.node));
    o.plant = hits.length ? hits.sort((a, b) => idx(a) - idx(b))[hits.length - 1] : null; // いちばん先の駅（竹内さんが仕込んだ先）
  }
  const tally = (key: "cls1" | "cls2") => { const m = new Map<string, number>(); for (const o of outs) if (o[key]) m.set(o[key]!, (m.get(o[key]!) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・"); };
  console.log(`■ 逆算の計画の この先 の外れの分け（竹内さん本人の番・本線の駅）`);
  console.log(`  1手先: ${tally("cls1")}`);
  console.log(`  2手先: ${tally("cls2")}`);
  // 竹内さんの先読みとの比べ: 仕込みの言葉がある番で、竹内さんの狙い（plant）が実際の変わり目（1つ目か2つ目）に入ったか・地図の この先 に入っているか
  const withPlant = outs.filter((o) => o.plant && o.changes.length);
  const plantHit = withPlant.filter((o) => o.changes.includes(o.plant!)).length;
  const mapHasPlant = withPlant.filter((o) => o.ahead.includes(o.plant!)).length;
  const mapHitWhenPlant = withPlant.filter((o) => o.ahead.some((a, i) => o.changes[i] === a)).length;
  console.log(`\n■ 竹内さんの先読み（文の中の仕込みの言葉がある番 ${withPlant.length}）`);
  console.log(`  竹内さんの狙いの駅が実際に来た: ${plantHit}/${withPlant.length}・地図の この先（2駅）に竹内さんの狙いが入っている: ${mapHasPlant}/${withPlant.length}・地図の この先 が当たった: ${mapHitWhenPlant}/${withPlant.length}`);
  const gap = new Map<string, number>(); for (const o of withPlant) if (!o.ahead.includes(o.plant!)) { const k = `${o.node}→竹内さんは ${o.plant}（地図は ${o.ahead.join("→")}）`; gap.set(k, (gap.get(k) ?? 0) + 1); }
  console.log(`  地図の この先 に無い竹内さんの狙い: ${[...gap].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("／") || "なし"}`);
  const miss2 = outs.filter((o) => o.cls2 && o.cls2 !== "当たり");
  console.log(`\n2手先の外れ ${miss2.length}番（会話の頭8字・時刻・駅 → 地図の この先 ／ 実際）:`);
  for (const o of miss2) console.log(`  ${o.conv} ${o.at.slice(5, 16)} ${o.node} → ${o.ahead.join("→")} ／ 実際 ${o.changes.join("→")} ・${o.cls2}${o.plant ? `・竹内さんの狙い ${o.plant}` : ""}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
