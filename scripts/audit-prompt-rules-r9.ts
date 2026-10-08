// scripts/audit-prompt-rules-r9.ts — 学習ルール（ai_prompt_rules）の全 action_type の総点検の材料（読み取りのみ・LLM 0）
// 2026-10-08 竹内さん「永久ルールかなり昔に入れたものも多いのでボトルネックになってしまっているものも多い可能性がある。改善する」
//   6巡目（scripts/audit-prompt-rules-review.ts）は generate_reply＋global の一部だけ。ここは全 action_type を同じ物差しで並べる:
//   ①どの経路に届くか（返信生成 v2 の何位・最終チェック・ブレイン〔global の永久 上位20・BOUNDARY 全件〕・AIX〔global＋その action〕）
//   ②「」の言い回しが スタッフの手打ち／AIX の送付文（365日）に何通あるか・ルールが禁じる向きか必須にする向きか
//   ③AI が知り得ない事を書かせる語・「必ず」・文字数
//   ④最終チェックの RULE_VIOLATION（line_watch_turns 60日）の evidence に、ルールの「」が当たる数（誤発火の出所の目安）
// 実行: npx tsx --env-file=.env.local scripts/audit-prompt-rules-r9.ts [--days=365] [--out=scripts/.replay-out/r9-rules]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { orderRulesForInjection, ruleOrigin } from "../app/lib/prompt-rules-format";
import { PROMPT_RULE_LIMIT_HIGH, PROMPT_RULE_ACTION_TYPES } from "../app/lib/prompt-rule-registry";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365"));
const OUT = arg("out", "scripts/.replay-out/r9-rules");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const skip = new Set<string>(TEST_CONVERSATION_IDS);
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s　！!？?。、😊😌🌟✨🙇‍♀️🙏]/gu, "");

type Rule = { id: string; rule_key: string; rule_text: string; action_type: string | null; condition_key: string | null; condition_value: string | null; priority: number; is_permanent: boolean; created_at: string | null; updated_at: string | null };
type Msg = { conversation_id: string; text: string | null; is_aix_generated: boolean | null; created_at: string };

async function page<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 400): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < max; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

/** 「」の言い回しを、〇〇 等で切った3字以上の部分の並びにする */
function quoteParts(q: string): string[] { return norm(q).split(/[〇○◯△×]+|\.\.\.|…|〜|～|\/|／/).filter((p) => p.length >= 3); }
/** その「」がルールの中で禁じる向きか（前後 30 字に 禁止・使わない 等） */
function quoteDirection(text: string, idx: number, len: number): "ban" | "must" | "neutral" {
  const around = text.slice(Math.max(0, idx - 30), idx + len + 30);
  if (/禁止|使わない|使用しない|使うな|避け|NG|ＮＧ|入れない|書かない|しない|不要|削除|言わない|不可|ではなく|ダメ/.test(around)) return "ban";
  if (/必ず|添え|入れる|使う|書く|含め|締め|始め|明記|伝える/.test(around)) return "must";
  return "neutral";
}
const UNKNOWABLE = /空室|空き(?:状況|あり|が)|募集中|1番手|一番手|競合|他の方|入居可能日|審査(?:結果|通過|に通)|交渉|値下げ|フリーレント|割引額|キャンセル料|残り\d|1部屋のみ|一部屋のみ|即入居|退去日/;

async function main() {
  mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true });
  const rules = await page<Rule>((a, b) => sb.from("ai_prompt_rules").select("id, rule_key, rule_text, action_type, condition_key, condition_value, priority, is_permanent, created_at, updated_at")
    .eq("is_active", true).not("rule_key", "like", "LEARN-%").order("rule_key").range(a, b));

  // ① 届く経路
  const grHigh = rules.filter((r) => !r.is_permanent && (r.action_type === "generate_reply" || r.action_type === null) && r.priority >= 4);
  const v2 = orderRulesForInjection(grHigh, { limit: PROMPT_RULE_LIMIT_HIGH });
  const v2Rank = new Map(v2.map((r, i) => [(r as Rule).id, i + 1]));
  const brainPerm = rules.filter((r) => r.is_permanent && r.action_type === null).sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id)).slice(0, 20);
  const brainPermIds = new Set(brainPerm.map((r) => r.id));
  const reach = (r: Rule): string => {
    const out: string[] = [];
    if (r.action_type === null) {
      if (r.is_permanent || r.priority >= 4) out.push(r.is_permanent ? "返信(永久)" : `返信#${v2Rank.get(r.id) ?? "外"}`, "最終チェック", "AIX全部");
      if (brainPermIds.has(r.id)) out.push("ブレイン(絶対)");
    } else if (r.action_type === "generate_reply") {
      out.push(r.is_permanent ? "返信(永久)" : v2Rank.has(r.id) ? `返信#${v2Rank.get(r.id)}` : "返信×(p<8か-gr)");
      out.push("最終チェック", "AIX会話を合わせる");
    } else if (PROMPT_RULE_ACTION_TYPES.has(r.action_type)) {
      out.push(r.priority >= 4 || r.is_permanent ? `AIX:${r.action_type}` : "AIX×(p<4)");
      out.push("ブレイン(行動の候補)");
    } else out.push(`×届かない(action_type=${r.action_type})`);
    if (r.rule_key.startsWith("BOUNDARY-")) out.push("ブレイン(線引き)");
    if (r.condition_key) out.push(`条件:${r.condition_key}=${r.condition_value}`);
    return out.join(" ");
  };

  // ② 実送信
  const msgs = await page<Msg>((a, b) => sb.from("messages").select("conversation_id, text, is_aix_generated, created_at").gte("created_at", since).eq("sender", "staff").order("created_at").range(a, b));
  const hand: string[] = []; const aix: string[] = []; const hand30: string[] = []; const aix30: string[] = [];
  const t30 = Date.now() - 30 * 86400_000;
  for (const m of msgs) {
    if (skip.has(m.conversation_id)) continue;
    const t = (m.text ?? "").trim();
    if (!t || /^\[画像\]|^\[スタンプ\]|^https?:\/\//.test(t)) continue;
    (m.is_aix_generated ? aix : hand).push(norm(t));
    if (Date.parse(m.created_at) >= t30) (m.is_aix_generated ? aix30 : hand30).push(norm(t));
  }
  console.log(`スタッフの手打ち ${hand.length}通・AIX ${aix.length}通（${DAYS}日＝記録の全期間 5/17〜・YUMA 等を除く）／直近30日 手打ち ${hand30.length}通・AIX ${aix30.length}通`);

  // ④ 最終チェックの RULE_VIOLATION（60日）
  const fc = await page<{ final_check: { issues?: Array<{ code?: string; evidence?: string }> } | null; conversation_id: string }>((a, b) => sb.from("line_watch_turns").select("conversation_id, final_check")
    .gte("customer_turn_at", new Date(Date.now() - 60 * 86400_000).toISOString()).not("final_check", "is", null).range(a, b), 50);
  const rvEvidence: string[] = [];
  for (const t of fc) { if (skip.has(t.conversation_id)) continue; for (const i of t.final_check?.issues ?? []) if (i.code === "RULE_VIOLATION" && i.evidence) rvEvidence.push(norm(i.evidence)); }
  console.log(`最終チェックの RULE_VIOLATION（60日）${rvEvidence.length}件`);

  const rows: Array<Record<string, unknown>> = [];
  for (const r of rules) {
    const text = String(r.rule_text);
    const qs = [...text.matchAll(/「([^」]{4,80})」/g)].slice(0, 6).map((m) => {
      const parts = quoteParts(m[1]);
      const dir = quoteDirection(text, m.index ?? 0, m[0].length);
      if (!parts.length) return { q: m[1], dir, hand: -1, aix: -1, hand30: -1, aix30: -1, rv: -1 };
      const hit = (arr: string[]) => arr.filter((t) => parts.every((p) => t.includes(p))).length;
      return { q: m[1], dir, hand: hit(hand), aix: hit(aix), hand30: hit(hand30), aix30: hit(aix30), rv: hit(rvEvidence) };
    });
    rows.push({
      id: r.id, key: r.rule_key, at: r.action_type ?? "(global)", perm: r.is_permanent, p: r.priority, origin: ruleOrigin(r.rule_key),
      created: (r.created_at ?? "").slice(0, 10), updated: (r.updated_at ?? "").slice(0, 10), chars: text.length,
      reach: reach(r), must: (text.match(/必ず/g) ?? []).length, unknowable: (text.match(UNKNOWABLE) ?? [])[0] ?? "",
      quotes: qs, text,
    });
  }
  writeFileSync(`${OUT}.json`, JSON.stringify(rows, null, 1));
  const tsv = ["at\tperm\tp\tcreated\tchars\treach\tmust\tunknowable\tid8\tkey\tquotes(dir:全期間 手打ち/AIX・30日 手打ち/AIX・RV60日)\ttext"];
  for (const r of rows.sort((a, b) => String(a.at).localeCompare(String(b.at)) || Number(b.perm) - Number(a.perm) || Number(b.p) - Number(a.p))) {
    const q = (r.quotes as Array<{ q: string; dir: string; hand: number; aix: number; hand30: number; aix30: number; rv: number }>).map((x) => `${x.q.slice(0, 24)}(${x.dir}:全${x.hand}/${x.aix}・30日${x.hand30}/${x.aix30}・RV${x.rv})`).join(" / ");
    tsv.push([r.at, r.perm ? "P" : "", r.p, r.created, r.chars, r.reach, r.must, r.unknowable, String(r.id).slice(0, 8), r.key, q, String(r.text).replace(/\s+/g, " ")].join("\t"));
  }
  writeFileSync(`${OUT}.tsv`, tsv.join("\n"));
  // 集計
  const by = new Map<string, { n: number; perm: number; chars: number; old: number }>();
  for (const r of rows) { const k = String(r.at); const a = by.get(k) ?? { n: 0, perm: 0, chars: 0, old: 0 }; a.n++; if (r.perm) a.perm++; a.chars += Number(r.chars); if (String(r.created) < "2026-09-01") a.old++; by.set(k, a); }
  for (const [k, a] of [...by].sort((x, y) => y[1].n - x[1].n)) console.log(`${k.padEnd(26)} ${String(a.n).padStart(4)}本 永久${a.perm} 8月以前${a.old} ${a.chars}字`);
  console.log(`返信生成 v2 に届く ${v2.length}本（上限 ${PROMPT_RULE_LIMIT_HIGH}）・ブレインの絶対ルール ${brainPerm.length}本`);
  console.log(`表: ${OUT}.tsv / ${OUT}.json`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
