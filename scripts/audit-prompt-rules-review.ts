// scripts/audit-prompt-rules-review.ts — 学習ルール（ai_prompt_rules の generate_reply＋global）の見直しの材料（読み取りのみ・LLM 0）
// 2026-10-07 6巡目（竹内さん「２最善のみなおしをする」）:
//   ①届くか: 今の並び（priority→更新の新しい順・上限200）と 6巡目の並び（prompt-rules-format.orderRulesForInjection）で何位か
//   ②スタッフの実送信と食い違うか: ルールの「」の言い回しが、スタッフの手打ち（365日）に何通あるか（使うなと言う言い回しを人が多く使う／
//     必ず添えろと言う言い回しを人がほとんど使わない＝創作を誘う）
//   ③線を引く数: 冒頭の呼び名・挨拶（その日最初か続きか）・定型の言い回しの割合
// 実行: npx tsx --env-file=.env.local scripts/audit-prompt-rules-review.ts [--days=365] [--out=scripts/.replay-out/r6-rules-review.tsv]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { orderRulesForInjection, ruleOrigin, type PromptRuleRow } from "../app/lib/prompt-rules-format";
import { PROMPT_RULE_LIMIT_HIGH, PROMPT_RULE_MIN_PRIORITY } from "../app/lib/prompt-rule-registry";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365"));
const OUT = arg("out", "scripts/.replay-out/r6-rules-review.tsv");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const skip = new Set<string>(TEST_CONVERSATION_IDS);
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s　！!？?。、😊😌🌟✨🙇‍♀️🙏]/gu, "");
const jstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

type Row = PromptRuleRow & { id: string; updated_at: string | null; created_at: string | null };
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

async function page<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 200): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < max; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const rules = await page<Row>((a, b) => sb.from("ai_prompt_rules").select("id, rule_key, rule_text, action_type, condition_key, condition_value, priority, is_permanent, updated_at, created_at")
    .eq("is_active", true).or("action_type.eq.generate_reply,action_type.is.null").not("rule_key", "like", "LEARN-%").order("rule_key").range(a, b));
  const high = rules.filter((r) => !r.is_permanent && (r.priority ?? 0) >= PROMPT_RULE_MIN_PRIORITY);
  const byOld = [...high].sort((x, y) => (y.priority - x.priority) || (Date.parse(y.updated_at ?? "") - Date.parse(x.updated_at ?? "")) || x.rule_key.localeCompare(y.rule_key));
  const oldRank = new Map(byOld.map((r, i) => [r.id, i + 1]));
  const newOrder = orderRulesForInjection(high, { limit: PROMPT_RULE_LIMIT_HIGH });
  const newRank = new Map(newOrder.map((r, i) => [(r as Row).id, i + 1]));

  // スタッフの手打ち（AIX の本文は除く）
  const msgs = await page<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).in("sender", ["staff", "customer"]).order("created_at").range(a, b), 400);
  const conv = new Map<string, Msg[]>();
  for (const m of msgs) { if (skip.has(m.conversation_id)) continue; const a = conv.get(m.conversation_id) ?? []; a.push(m); conv.set(m.conversation_id, a); }
  const names = new Map<string, string>();
  const ids = [...conv.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name, call_name").in("id", ids.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null; call_name: string | null }>) names.set(c.id, (c.call_name || c.customer_name || "").trim());
  }
  const staffTexts: string[] = [];
  // ③ 返事の最初の1通（お客様の発言の後の最初のスタッフの手打ち）: 冒頭の呼び名・挨拶を、その日最初の返事か続きかで分ける
  const st = { firstOfDay: { n: 0, name: 0, greet: 0, nameOrGreet: 0 }, cont: { n: 0, name: 0, greet: 0, nameOrGreet: 0 } };
  for (const [cid, ms] of conv) {
    const nm = names.get(cid) ?? "";
    const staffDays = new Set<string>();
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender !== "staff") continue;
      const t = (m.text ?? "").trim();
      const hand = !m.is_aix_generated && t && !/^\[画像\]|^\[スタンプ\]|^https?:\/\//.test(t);
      if (hand) staffTexts.push(t);
      const prev = ms[i - 1];
      if (hand && prev && prev.sender === "customer") {
        const day = jstDay(m.created_at);
        const bucket = staffDays.has(day) ? st.cont : st.firstOfDay;
        const head = t.split("\n").slice(0, 2).join("");
        const nameHit = nm.length >= 1 && (head.startsWith(nm) || head.startsWith(`${nm}さん`) || /^[^\n]{1,12}さん/.test(t.split("\n")[0]));
        const greet = /お世話になっております|お世話になります|はじめまして|初めまして/.test(head);
        bucket.n++; if (nameHit) bucket.name++; if (greet) bucket.greet++; if (nameHit || greet) bucket.nameOrGreet++;
      }
      staffDays.add(jstDay(m.created_at));
    }
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  console.log(`スタッフの手打ち ${staffTexts.length}通（${DAYS}日・YUMA 除く）`);
  console.log(`返事の最初の1通・その日最初 n=${st.firstOfDay.n}: 冒頭の呼び名 ${pct(st.firstOfDay.name, st.firstOfDay.n)}・挨拶 ${pct(st.firstOfDay.greet, st.firstOfDay.n)}`);
  console.log(`返事の最初の1通・同じ日の続き n=${st.cont.n}: 冒頭の呼び名 ${pct(st.cont.name, st.cont.n)}・挨拶 ${pct(st.cont.greet, st.cont.n)}`);
  const normed = staffTexts.map(norm);
  const count = (re: RegExp) => staffTexts.filter((t) => re.test(t)).length;
  const fixed: Array<[string, RegExp]> = [
    ["お手隙の際にご査収", /お手隙の際に?ご査収/], ["確認させて頂きます/いただきます", /確認させて(?:頂|いただ)きます/], ["ご案内可能です", /ご案内(?:可能|出来|でき)ます|ご案内可能です/],
    ["少々お待ちください", /少々お待ち/], ["😊！！", /😊！！/], ["1部屋のみ", /1部屋のみ|一部屋のみ/], ["全力でサポート", /全力でサポート/],
    ["初期費用も最大限割引", /初期費用も最大限割引/], ["周辺全域", /周辺全域/], ["一度失礼致します", /一度失礼(?:致|いた)します/], ["お役に立て", /お役に立て/],
    ["審査前であれば無料でキャンセル", /審査前(?:であれば|なら)[^\n]{0,8}(?:無料|キャンセル料)/], ["キャンセル待ち", /キャンセル待ち/], ["お待たせ致しました", /お待たせ(?:致|いた)しました/],
    ["何卒よろしくお願い致します", /何卒よろしくお願い(?:致|いた)します/], ["〇〇さん単独の1行目", /^[^\n]{1,12}さん\n/],
  ];
  console.log("\n言い回しの数（スタッフの手打ち）:");
  for (const [k, re] of fixed) console.log(`  ${k.padEnd(28)} ${String(count(re)).padStart(6)}  (${pct(count(re), staffTexts.length)})`);

  // ②ルールごと: 「」の言い回し（〇〇 等は何でもよい）の数
  const rows: string[] = ["old_rank\tnew_rank\tid8\torigin\tpriority\tpermanent\tupdated\tkey\tquotes(staff_hits)\ttext"];
  for (const r of rules.sort((a, b) => (oldRank.get(a.id) ?? 9999) - (oldRank.get(b.id) ?? 9999))) {
    const quotes = [...String(r.rule_text).matchAll(/「([^」]{4,60})」/g)].map((m) => m[1]);
    const qs = quotes.slice(0, 4).map((q) => {
      const parts = norm(q).split(/[〇○◯△]+|\.\.\.|…|〜/).filter((p) => p.length >= 3);
      if (!parts.length) return `${q.slice(0, 18)}(-)`;
      const hit = normed.filter((t) => parts.every((p) => t.includes(p))).length;
      return `${q.slice(0, 18)}(${hit})`;
    }).join(" / ");
    rows.push([r.is_permanent ? "P" : (oldRank.get(r.id) ?? "-"), r.is_permanent ? "P" : (newRank.get(r.id) ?? "-"), r.id.slice(0, 8), ruleOrigin(r.rule_key), r.priority, r.is_permanent ? 1 : 0, (r.updated_at ?? "").slice(0, 10), r.rule_key, qs, String(r.rule_text).replace(/\s+/g, " ").slice(0, 220)].join("\t"));
  }
  writeFileSync(OUT, rows.join("\n"));
  const reachedOld = byOld.slice(0, PROMPT_RULE_LIMIT_HIGH);
  const cnt = (xs: Row[], o: string) => xs.filter((r) => ruleOrigin(r.rule_key) === o).length;
  console.log(`\n届く（上限 ${PROMPT_RULE_LIMIT_HIGH}）: 今の並び human ${cnt(reachedOld, "human")}・auto ${cnt(reachedOld, "auto")}・routing ${cnt(reachedOld, "routing")} ／ 6巡目の並び human ${cnt(newOrder as Row[], "human")}・auto ${cnt(newOrder as Row[], "auto")}・routing ${cnt(newOrder as Row[], "routing")}`);
  console.log(`表: ${OUT}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
