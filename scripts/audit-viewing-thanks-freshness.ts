// scripts/audit-viewing-thanks-freshness.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-thanks-freshness.ts
//
// 2026-09-19 竹内（慶次事例の続き）「内覧挨拶は当日にAIXからおこなうなら分かるが、
//   今回の場合持ち越したことで変な文になっていた」:
//   「本日お時間頂きありがとうございました」型の実送信が、**内覧から何時間後**に送られているかを数える。
//   設計知見「強い言葉は回数で価値が決まる（会話×日ごとの回数で線を引く）」と同じ型で、鮮度の線を引く。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

const THANKS_RE = /(?:本日|先日|昨日)[^\n。！!]{0,8}(?:ご内覧|内覧|ご見学|お時間)[^\n。！!]{0,10}(?:頂き|いただき|くださり|下さり)[^\n。！!]{0,8}(?:ありがとう|有難う)/;
/** 内覧が起きた印: お客様の到着連絡 / 待ち合わせの案内 */
const ARRIVED_RE = /着きました|つきました|到着(?:し|です|してます|しております)|向かって|着いてます|已经/;
const MEETING_RE = /待ち合わせ|待合せ|現地エントランス|現地集合|現地でお待ち/;
const jst = (iso: string) => new Date(new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
const jstYmd = (iso: string) => { const d = jst(iso); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

async function main() {
  let from = 0; const size = 1000;
  const hits: Array<{ conv: string; text: string; at: string }> = [];
  for (;;) {
    const { data, error } = await sb.from("messages")
      .select("conversation_id, text, created_at").neq("sender", "customer").not("text", "is", null)
      .range(from, from + size - 1);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    for (const m of data) { const t = String(m.text ?? ""); if (THANKS_RE.test(t)) hits.push({ conv: m.conversation_id as string, text: t, at: m.created_at as string }); }
    if (data.length < size) break;
    from += size;
  }
  console.log(`=== 「内覧のお礼」の実送信 ${hits.length}通 ===\n`);

  const buckets: Record<string, number> = {};
  const sameDay: number[] = []; const noEvidence: Array<{ at: string; text: string }> = [];
  for (const h of hits) {
    // その前の「内覧が起きた印」を探す（お客様の到着連絡 → 無ければ待ち合わせの案内）
    const { data: prev } = await sb.from("messages")
      .select("sender, text, created_at").eq("conversation_id", h.conv)
      .lt("created_at", h.at).order("created_at", { ascending: false }).limit(60);
    const arrived = (prev ?? []).find((m) => m.sender === "customer" && ARRIVED_RE.test(String(m.text ?? "")));
    const meet = (prev ?? []).find((m) => m.sender !== "customer" && MEETING_RE.test(String(m.text ?? "")));
    const base = arrived?.created_at ?? meet?.created_at ?? null;
    if (!base) { noEvidence.push({ at: h.at, text: h.text }); buckets["印が見つからない"] = (buckets["印が見つからない"] ?? 0) + 1; continue; }
    const hours = (Date.parse(h.at) - Date.parse(base as string)) / 3600_000;
    const same = jstYmd(h.at) === jstYmd(base as string);
    if (same) sameDay.push(hours);
    const k = same ? "同じ日（JST）" : hours <= 24 ? "翌日まで（24h以内）" : hours <= 48 ? "2日以内" : hours <= 24 * 7 ? "1週間以内" : "1週間超";
    buckets[k] = (buckets[k] ?? 0) + 1;
  }
  console.log("--- 内覧の印から、お礼を送るまで ---");
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(3)}通 （${((100 * v) / Math.max(hits.length, 1)).toFixed(1)}%）`);
  }
  if (sameDay.length) {
    const s = [...sameDay].sort((a, b) => a - b);
    console.log(`\n  同じ日の内訳: 中央値 ${s[Math.floor(s.length / 2)].toFixed(1)}h / 最大 ${s[s.length - 1].toFixed(1)}h`);
  }
  console.log(`\n--- 印が見つからなかった実物（5件）---`);
  noEvidence.slice(0, 5).forEach((n) => console.log(`  [${new Date(n.at).toLocaleDateString("ja-JP")}] ${n.text.replace(/\n/g, " / ").slice(0, 100)}`));

  // ── 文中の時制語で測り直す（「本日」なら当日に内覧の印があるはず）──────────────
  console.log(`\n=== 文中の時制語 × 内覧の印が同じ日か ===`);
  const byWord: Record<string, { n: number; same: number; none: number; gapH: number[] }> = {};
  for (const h of hits) {
    const w = /本日/.test(h.text) ? "本日" : /昨日/.test(h.text) ? "昨日" : /先日/.test(h.text) ? "先日" : "その他";
    byWord[w] ??= { n: 0, same: 0, none: 0, gapH: [] };
    byWord[w].n++;
    const { data: prev } = await sb.from("messages")
      .select("sender, text, created_at").eq("conversation_id", h.conv)
      .lt("created_at", h.at).order("created_at", { ascending: false }).limit(60);
    const arrived = (prev ?? []).find((m) => m.sender === "customer" && ARRIVED_RE.test(String(m.text ?? "")));
    const meet = (prev ?? []).find((m) => m.sender !== "customer" && MEETING_RE.test(String(m.text ?? "")));
    const base = arrived?.created_at ?? meet?.created_at ?? null;
    if (!base) { byWord[w].none++; continue; }
    if (jstYmd(h.at) === jstYmd(base as string)) byWord[w].same++;
    byWord[w].gapH.push((Date.parse(h.at) - Date.parse(base as string)) / 3600_000);
  }
  for (const [w, v] of Object.entries(byWord).sort((a, b) => b[1].n - a[1].n)) {
    const g = v.gapH.sort((a, b) => a - b);
    const med = g.length ? g[Math.floor(g.length / 2)].toFixed(1) : "-";
    console.log(`  「${w}」 ${String(v.n).padStart(3)}通 / 同じ日 ${String(v.same).padStart(3)}通（${((100 * v.same) / Math.max(v.n, 1)).toFixed(0)}%）/ 印なし ${v.none}通 / 間隔の中央値 ${med}h`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
