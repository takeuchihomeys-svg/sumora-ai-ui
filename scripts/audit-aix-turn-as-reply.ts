// scripts/audit-aix-turn-as-reply.ts — 主の数（AIX の番の一致・端末の版）の一番大きい外れ「竹内さんは AIX・ブレインは返信」を1番ずつ分ける（台帳 #688・読むだけ・LLM なし・費用 0）
// 2026-11-25 作業員A（統括役の頼み）: 出所の台本（audit-aix-turn-judgment）の json を読み、地図の木と同じ分けて外す印（決定・少数側・割れ・時刻）を付けた上で、
//   ④ スタッフだけが知る結果（前の番の約束があり・お客様はお礼／了承／その他・竹内さんは20分以上後に AIX）
//   材料が手元に無い（物件＝送れる候補0でpp なし／物件確認＝3日の確認の結果0）
//   ブレインは約束（2段）だった（竹内さんは今 AIX）／ブレインは返信（約束でもない）
//   を AIX の種類ごとに数える。本文・名前は出さない（会話の頭8字・種類・数だけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-turn-as-reply.ts --json=<audit-aix-turn-judgment の json>
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MAP_ROOTS, staffOnlyResultOf, BROUGHT_SHAPE_RE, type DeviceTurnRow } from "../app/lib/metric-map";
import { buildTreeFromJson } from "./lib/metric-map-server";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = DeviceTurnRow & { conv: string; at: string; prevPromise?: string[]; route?: string; src?: string | null; minDecToAix?: number | null; burst?: string };
const fam = (k: string) => (k === "property_send" || k === "property" ? "property" : k);

(async () => {
  const rows = JSON.parse(readFileSync(arg("json"), "utf8")) as Row[];
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const def = MAP_ROOTS.find((r) => r.metric === "aix_turn:match_60d_device")!;
  const spec = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8"));
  const t = await buildTreeFromJson(sb, def, rows, { spec });
  if (!t) throw new Error("木が作れない");
  const aside = new Map<number, string>();
  for (const id of t.decided.keys()) aside.set(id, "決定で改めた");
  for (const [id, v] of t.sides) if (v.side === "minority" || v.side === "split") aside.set(id, `${v.side === "minority" ? "竹内さんの少数側" : "割れ"}（形 ${v.shape}・竹内さんの多い方 ${v.majority} ${Math.round(v.share * 100)}%/${v.n}）`);
  const xs = rows.filter((r) => r.cls !== "reply" && r.v === "AIXの番を返信");
  const out = xs.map((r) => {
    const m = r.mat ?? {};
    const k = r.tk ?? "?";
    let cls: string;
    if (aside.has(r.id)) cls = `分けて外す: ${aside.get(r.id)}`;
    else if (k === "greeting_viewing") cls = "分けて外す: 時刻で送る物";
    else if (staffOnlyResultOf(r)) cls = "④スタッフだけが知る結果（前の約束の果たし・20分以上後）";
    else if (k === "property" ? (m.pend ?? 0) === 0 && !m.pp : k === "property_check_result" ? (m.checked ?? 0) === 0 && (m.taskResult ?? 0) === 0 : false) cls = "材料が手元に無い";
    else if (r.route === "two_stage") cls = "ブレインは2段の約束（竹内さんは今 AIX）";
    else cls = "ブレインは返信（約束でもない）";
    return { ...r, why: cls };
  });
  console.log(`■ 竹内さんは AIX・ブレインは返信（60日・${xs.length}番）`);
  const whys = [...new Set(out.map((o) => o.why))].sort();
  const kinds = [...new Set(out.map((o) => o.tk ?? "?"))].sort();
  console.log(`| 分け | n | ${kinds.join(" | ")} |\n|---|---|${kinds.map(() => "---").join("|")}|`);
  for (const w of whys) { const ys = out.filter((o) => o.why === w); console.log(`| ${w} | ${ys.length} | ${kinds.map((k) => ys.filter((o) => (o.tk ?? "?") === k).length).join(" | ")} |`); }
  console.log("\n1番ずつ（会話の頭8字・時刻・種類・番の形・判断から AIX までの分・ブレインの出所・分け）");
  for (const o of out) console.log(`  ${o.id} ${o.conv} ${o.at} ${o.cls}/${o.tk} ${o.burst} ${o.minDecToAix ?? "—"}分 ${o.src ?? "—"} → ${o.why}`);
  // 割れの形「前24時間にお客様が物件を送ってきた」を竹内さん本人の全部の番（返信の番も）で、確認の約束が前の番に開いているか × お客様の連投の型 で割る（--split）
  if (process.argv.includes("--split")) {
    const all = rows;
    const byConv = new Map<string, Row[]>();
    for (const r of all) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), r]);
    const { data: wt } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at").in("id", all.map((r) => r.id));
    const full = new Map(((wt ?? []) as Array<{ id: number; conversation_id: string; customer_turn_at: string }>).map((w) => [w.id, w]));
    const tab = new Map<string, { reply: number; aix: number; ids: string[] }>();
    for (const r of all) {
      const w = full.get(r.id); if (!w) continue;
      const at = Date.parse(w.customer_turn_at);
      const { data } = await sb.from("messages").select("sender,text,created_at,image_url").eq("conversation_id", w.conversation_id).eq("sender", "customer").gte("created_at", new Date(at - 86_400_000).toISOString()).lte("created_at", new Date(at + 1000).toISOString()).limit(500);
      const b = ((data ?? []) as Array<{ text: string | null; image_url: string | null }>).some((m) => BROUGHT_SHAPE_RE.test(String(m.text ?? "")) || !!m.image_url);
      if (!b) continue;
      const pp = (r.prevPromise ?? []).includes("property_check_result") ? "確認の約束が開いている" : "確認の約束なし";
      const k = `${pp}｜${r.burst ?? "other"}`;
      const o = tab.get(k) ?? { reply: 0, aix: 0, ids: [] };
      if (r.cls === "reply" || r.cls === "two_stage") o.reply++; else o.aix++;
      if (r.cls !== "reply" && r.cls !== "two_stage") o.ids.push(`${r.conv}(${String(r.at).slice(5, 10)}・${r.tk})`);
      tab.set(k, o);
    }
    console.log("\n■ 割れの形「前24時間にお客様が物件を送ってきた」を割る（竹内さん本人の全部の番・返信が先／AIX が先）");
    for (const [k, o] of [...tab].sort()) console.log(`  ${k}: 返信が先 ${o.reply}・AIX が先 ${o.aix}${o.ids.length ? `（AIX の例 ${o.ids.slice(0, 4).join("・")}）` : ""}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
