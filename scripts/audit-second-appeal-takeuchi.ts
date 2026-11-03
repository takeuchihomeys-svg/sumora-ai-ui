// scripts/audit-second-appeal-takeuchi.ts — AIX の2通目で「何を訴求しているか」を、竹内さん本人の実送信と AI の2通目の下書きで並べる（LLM なし）
//
// 2026-10-29 作業員5（竹内さん 10/29 KB 9f4f0b48「AIX の2通目はお客様に刺さるかを決める一番大事な文」）。
//   竹内さんの2通目: AIX（物件オススメ・物件ピックアップした・見積書送る）の1通目の直後 20 分以内に竹内さん（messages.staff_writer=takeuchi）が手で送った文。
//   AI の2通目: aix_generate_log（conditions_snapshot.source=aix-template-generate）の生成文。スタッフの文は正解にしない（竹内さんの文が物差し）。
//   訴求の要素（決定論の網）: 通勤先とのつながり・初期費用の節約・敷金礼金なし・ネット無料・角部屋・広さ・築年・設備・入居時期・家賃総額・希望との結び・比べ。
//   見る物: 場面ごとの要素の割合・何個言うか・最初に言う要素・節約額の言い方・締め（内覧／申込／ご査収）。
// 実行: npx tsx --env-file=.env.local scripts/audit-second-appeal-takeuchi.ts [--days=60] [--out=<file.md>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (f: string, d = "") => argv.find((a) => a.startsWith(`--${f}=`))?.slice(f.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

export const APPEAL_ELEMENTS: Array<{ key: string; ja: string; re: RegExp }> = [
  { key: "commute", ja: "通勤先・よく行く所とのつながり", re: /通いやすい|通勤|職場|お勤め|会社まで|乗り換えなし|乗換なし|直通|一本で|まで(?:電車|徒歩)?[0-9０-９]{1,2}分/ },
  { key: "wish_link", ja: "希望・条件との結び（〜さんのご希望の）", re: /ご希望の|ご条件(?:に|の)|(?:気にされて|こだわり)|さんにピッタリ|さんの(?:ご希望|条件)/ },
  { key: "saving", ja: "初期費用の節約（額・お得）", re: /節約|お得|[0-9,，]+円(?:も)?(?:安く|抑え|お安く)|初期費用[^。！!\n]{0,14}(?:抑え|安く|無料|0円)|前家賃(?:だけ|のみ)/ },
  { key: "shikirei", ja: "敷金礼金なし", re: /敷金礼金(?:なし|無し|0|ゼロ)|礼金(?:なし|無し|0)/ },
  { key: "rent_total", ja: "家賃管理費込みの額", re: /家賃管理費込|管理費込み?[0-9０-９,]+円|総額[0-9,]+円/ },
  { key: "net_free", ja: "ネット無料", re: /(?:インターネット|ネット|Wi-?Fi)(?:無料|使用料不要|使い放題|費用不要)/i },
  { key: "corner", ja: "角部屋・日当たり・眺望", re: /角部屋|日当たり|南向き|眺望|眺め|風通し/ },
  { key: "size", ja: "広さ・間取りの使いやすさ", re: /[0-9０-９.．]+帖|広め|広々|広く|使いやすい間取り|独立した?洋室/ },
  { key: "age", ja: "築年・築浅・リノベ", re: /築浅|新築|[0-9０-９]{4}年[0-9０-９]{1,2}月築|リノベ|リフォーム/ },
  { key: "equipment", ja: "設備（浴室乾燥・独立洗面・オートロック等）", re: /浴室乾燥|独立洗面|オートロック|宅配ボックス|システムキッチン|バストイレ別|追い焚き|追焚|2口|二口|コンロ|ウォークイン|駐車場|駐輪場/ },
  { key: "station", ja: "駅・徒歩分", re: /「[^」]{1,12}」駅|駅(?:徒歩|から)|徒歩[0-9０-９]{1,2}分/ },
  { key: "move_in", ja: "入居時期・即入居", re: /即入居|入居可能|[0-9０-９]{1,2}月(?:中|上旬|中旬|下旬|末)(?:の|に|まで)?(?:ご)?入居/ },
  { key: "compare", ja: "比べ（〜より・他と比べ）", re: /よりも|と比べ|と比較|(?:お部屋|物件)より[^。！!\n]{0,10}(?:安|広|近|新)/ },
  { key: "popular", ja: "人気・すぐ決まる", re: /人気|すぐに?(?:決まって|埋まって|申込)|お問い合わせ(?:が)?多い/ },
];
const CLOSING: Array<{ key: string; re: RegExp }> = [
  { key: "apply", re: /お申込|お部屋(?:を)?抑え|押さえ/ },
  { key: "viewing", re: /ご案内させて|ご内覧|内覧/ },
  { key: "receipt", re: /ご査収/ },
];
export function appealOf(text: string): { els: string[]; first: string | null; closing: string[] } {
  const t = String(text ?? "");
  const hits = APPEAL_ELEMENTS.map((e) => ({ key: e.key, at: t.search(e.re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  return { els: hits.map((h) => h.key), first: hits[0]?.key ?? null, closing: CLOSING.filter((c) => c.re.test(t)).map((c) => c.key) };
}

type Pair = { scene: string; text: string; at: string; conv: string; id: string };
async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  // 1通目の AIX（場面）
  const aix: Array<{ conversation_id: string; aix_type: string; created_at: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", since)
      .in("aix_type", ["property_recommendation", "property_send", "estimate_sheet"]).order("created_at").range(from, from + 999);
    aix.push(...((data ?? []) as typeof aix));
    if (!data || data.length < 1000) break;
  }
  // 竹内さんの2通目（1通目の後 20 分以内・AIX でない手の文）
  const tk: Pair[] = [];
  const byConv = new Map<string, typeof aix>();
  for (const a of aix) { const l = byConv.get(a.conversation_id) ?? []; l.push(a); byConv.set(a.conversation_id, l); }
  for (const [conv, list] of byConv) {
    const { data } = await sb.from("messages").select("id, text, created_at, staff_writer, is_aix_generated, sender")
      .eq("conversation_id", conv).eq("sender", "staff").gte("created_at", since).order("created_at").limit(2000);
    const msgs = (data ?? []) as Array<{ id: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null }>;
    for (const a of list) {
      const t0 = Date.parse(a.created_at);
      const m = msgs.find((x) => !x.is_aix_generated && x.staff_writer === "takeuchi" && (x.text ?? "").length >= 40 && (x.text ?? "") !== "[画像]"
        && Date.parse(x.created_at) > t0 && Date.parse(x.created_at) - t0 <= 20 * 60_000);
      if (m) tk.push({ scene: a.aix_type, text: m.text ?? "", at: m.created_at, conv, id: m.id });
    }
  }
  // AI の2通目（aix_generate_log）
  const ai: Pair[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("aix_generate_log").select("id, action_type, conversation_id, generated_text, created_at, conditions_snapshot")
      .gte("created_at", since).in("action_type", ["property_recommendation", "property_send", "estimate_sheet"]).order("created_at").range(from, from + 999);
    for (const r of (data ?? []) as Array<{ id: string; action_type: string; conversation_id: string; generated_text: string | null; created_at: string; conditions_snapshot: { source?: string } | null }>) {
      if (r.conditions_snapshot?.source !== "aix-template-generate" || !(r.generated_text ?? "").trim()) continue;
      ai.push({ scene: r.action_type, text: r.generated_text ?? "", at: r.created_at, conv: r.conversation_id, id: r.id });
    }
    if (!data || data.length < 1000) break;
  }
  const lines: string[] = [`# AIX の2通目の訴求（直近 ${DAYS} 日・竹内さんの実送信 vs AI の2通目）`, ""];
  for (const scene of ["property_recommendation", "property_send", "estimate_sheet"]) {
    const T = tk.filter((p) => p.scene === scene), A = ai.filter((p) => p.scene === scene);
    if (!T.length && !A.length) continue;
    const rate = (ps: Pair[], k: string) => ps.length ? `${Math.round(100 * ps.filter((p) => appealOf(p.text).els.includes(k)).length / ps.length)}%` : "-";
    const firstRate = (ps: Pair[], k: string) => ps.length ? `${Math.round(100 * ps.filter((p) => appealOf(p.text).first === k).length / ps.length)}%` : "-";
    const avg = (ps: Pair[]) => ps.length ? (ps.reduce((s, p) => s + appealOf(p.text).els.length, 0) / ps.length).toFixed(1) : "-";
    const close = (ps: Pair[], k: string) => ps.length ? `${Math.round(100 * ps.filter((p) => appealOf(p.text).closing.includes(k)).length / ps.length)}%` : "-";
    lines.push(`## ${scene}（竹内さん ${T.length} 通・AI ${A.length} 通）`, `要素の数の平均: 竹内さん ${avg(T)}・AI ${avg(A)}`, "", "| 要素 | 竹内さん（含む／最初） | AI（含む／最初） |", "|---|---|---|");
    for (const e of APPEAL_ELEMENTS) lines.push(`| ${e.ja} | ${rate(T, e.key)}／${firstRate(T, e.key)} | ${rate(A, e.key)}／${firstRate(A, e.key)} |`);
    lines.push("", `締め: 内覧 竹内さん ${close(T, "viewing")}・AI ${close(A, "viewing")}／申込 ${close(T, "apply")}・${close(A, "apply")}／ご査収 ${close(T, "receipt")}・${close(A, "receipt")}`, "");
    lines.push("竹内さんの実物（新しい順 5通）:");
    for (const p of T.slice(-5).reverse()) lines.push(`- ${p.at.slice(0, 10)} ${p.id}: ${p.text.replace(/\s+/g, " ").slice(0, 220)}`);
    lines.push("");
  }
  const md = lines.join("\n");
  const out = arg("out");
  if (out) writeFileSync(out, md);
  console.log(md);
}
main().catch((e) => { console.error(e); process.exit(1); });
