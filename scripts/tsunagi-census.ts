// scripts/tsunagi-census.ts — 竹内さんの実際の送信のつなぎの型を全部分けて数える（読むだけ・LLM なし・費用 0）
//   2026-11-15 作業員H（竹内さん 11/15「つなぎの部分弱いところ強化」・統括役の頼み 1）。型の読みは scripts/lib/tsunagi.ts（テスト付き）。
//   元: takeuchi_compose_examples（竹内さん本人の送信・1,303通・7/11〜11/12）。同じ会話で 10分以内に続く通を1つの番にまとめて「何通目」を出す。
//   欄: 場面 × AIX の後か × 何通目 × 強さ × 文の中の位置（最後の文か）＋入れない番の理由。
//   --brain で、その通の前の一番近いブレインの判断（brain_decision_logs.digest の気持ち emoF・地図の駅 sg・重点 fc）でも分ける（会話ごとの読み＝夜に）。
//   使い方: npx tsx --env-file=<.env.local> scripts/tsunagi-census.ts [--days=90] [--brain] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { tsunagiOf, noneReasonOf, TSUNAGI_KINDS, TSUNAGI_JA, NONE_REASON_JA, type TsunagiKind, type NoneReason } from "./lib/tsunagi";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const days = Number(arg("days") ?? "90"), withBrain = process.argv.includes("--brain");
const jstHour = (new Date().getUTCHours() + 9) % 24;
if (withBrain && jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.error("--brain は DB の読みが多い＝22時以降に"); process.exit(1); }

type Row = { message_id: string; conversation_key: string; sent_at: string; scene: string | null; purpose: string | null; body: string | null; after_aix: boolean | null };
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows: Row[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("takeuchi_compose_examples").select("message_id, conversation_key, sent_at, scene, purpose, body, after_aix").gte("sent_at", since).order("conversation_key").order("sent_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  // 何通目（同じ会話で 10分以内に続く通）
  const msgNo = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i - 1], r = rows[i];
    const cont = p && p.conversation_key === r.conversation_key && Date.parse(r.sent_at) - Date.parse(p.sent_at) <= 10 * 60_000;
    msgNo.set(r.message_id, cont ? (msgNo.get(p.message_id) ?? 1) + 1 : 1);
  }
  // ブレインの読み（--brain の時だけ）: その通の前の一番近い判断
  const brainOf = new Map<string, { emo: string; stage: string; focus: string }>();
  if (withBrain) {
    const { data: msgs } = await sb.from("messages").select("id, conversation_id").in("id", rows.slice(0, 1).map((r) => r.message_id));
    void msgs; // 会話の id は messages から（conversation_key が会話の id と同じでない時のため）
    const convOf = new Map<string, string>();
    for (let i = 0; i < rows.length; i += 200) {
      const { data } = await sb.from("messages").select("id, conversation_id").in("id", rows.slice(i, i + 200).map((r) => r.message_id));
      for (const m of (data ?? []) as Array<{ id: string; conversation_id: string }>) convOf.set(m.id, m.conversation_id);
    }
    const convs = [...new Set(convOf.values())];
    const dec = new Map<string, Array<{ at: number; emo: string; stage: string; focus: string }>>();
    for (let i = 0; i < convs.length; i += 50) {
      const { data } = await sb.from("brain_decision_logs").select("conversation_id, created_at, emoF:digest->>emoF, sg:digest->>sg, fc:digest->>fc").in("conversation_id", convs.slice(i, i + 50)).gte("created_at", new Date(Date.parse(since) - 86_400_000).toISOString()).order("created_at").limit(20000);
      for (const d of (data ?? []) as Array<{ conversation_id: string; created_at: string; emoF: string | null; sg: string | null; fc: string | null }>) {
        const a = dec.get(d.conversation_id) ?? []; a.push({ at: Date.parse(d.created_at), emo: d.emoF ?? "?", stage: d.sg ?? "?", focus: (d.fc ?? "?").split(/[|:]/)[0] }); dec.set(d.conversation_id, a);
      }
    }
    for (const r of rows) {
      const c = convOf.get(r.message_id); if (!c) continue;
      const t = Date.parse(r.sent_at);
      const ds = (dec.get(c) ?? []).filter((d) => d.at <= t && t - d.at <= 6 * 3_600_000);
      const last = ds[ds.length - 1];
      if (last) brainOf.set(r.message_id, { emo: last.emo, stage: last.stage, focus: last.focus });
    }
  }
  type Cell = Record<TsunagiKind, number> & { n: number };
  const blank = (): Cell => Object.assign({ n: 0 }, Object.fromEntries(TSUNAGI_KINDS.map((k) => [k, 0]))) as Cell;
  const by: Record<string, Map<string, Cell>> = { 全体: new Map(), 場面: new Map(), AIXの後: new Map(), 何通目: new Map(), 強さ: new Map(), 位置: new Map(), 気持ち: new Map(), 地図の駅: new Map(), 重点: new Map() };
  const add = (axis: string, key: string, k: TsunagiKind) => { const m = by[axis]; const c = m.get(key) ?? blank(); c.n++; c[k]++; m.set(key, c); };
  const none = new Map<NoneReason, number>();
  const strengthBy = new Map<string, number>();
  for (const r of rows) {
    const tz = tsunagiOf(r.body ?? "");
    add("全体", "全体", tz.kind);
    add("場面", r.scene ?? "?", tz.kind);
    add("AIXの後", r.after_aix ? "AIX の後" : "AIX の前・無し", tz.kind);
    add("何通目", `${Math.min(msgNo.get(r.message_id) ?? 1, 3)}${(msgNo.get(r.message_id) ?? 1) >= 3 ? "通目以降" : "通目"}`, tz.kind);
    if (tz.kind !== "none") { add("強さ", tz.strength ?? "?", tz.kind); add("位置", tz.atLast ? "最後の文" : "途中の文", tz.kind); strengthBy.set(`${tz.kind}:${tz.strength}`, (strengthBy.get(`${tz.kind}:${tz.strength}`) ?? 0) + 1); }
    else { const why = noneReasonOf({ afterAix: !!r.after_aix, scene: r.scene, purpose: r.purpose }); none.set(why, (none.get(why) ?? 0) + 1); }
    const b = brainOf.get(r.message_id);
    if (b) { add("気持ち", b.emo, tz.kind); add("地図の駅", b.stage, tz.kind); add("重点", b.focus, tz.kind); }
  }
  const head = ["軸", "値", "n", ...TSUNAGI_KINDS.map((k) => TSUNAGI_JA[k])].join("\t");
  console.log(`竹内さんの送信 ${rows.length}通（${days}日）`);
  console.log(head);
  for (const [axis, m] of Object.entries(by)) for (const [key, c] of [...m.entries()].sort((a, b) => b[1].n - a[1].n)) if (c.n >= 3) console.log([axis, key, c.n, ...TSUNAGI_KINDS.map((k) => `${Math.round((c[k] / c.n) * 100)}%`)].join("\t"));
  console.log("\n入れない番の理由"); for (const [k, v] of [...none.entries()].sort((a, b) => b[1] - a[1])) console.log(`${NONE_REASON_JA[k]}\t${v}`);
  console.log("\n型×強さ"); for (const [k, v] of [...strengthBy.entries()].sort((a, b) => b[1] - a[1])) console.log(`${k}\t${v}`);
  const j = arg("json");
  if (j) writeFileSync(j, JSON.stringify({ at: new Date().toISOString(), days, n: rows.length, by: Object.fromEntries(Object.entries(by).map(([a, m]) => [a, Object.fromEntries(m)])), none: Object.fromEntries(none), strength: Object.fromEntries(strengthBy) }, null, 1));
})();
