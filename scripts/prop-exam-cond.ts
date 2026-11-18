// scripts/prop-exam-cond.ts — 物件出しの試験 B: 条件の読み取り（決定論の段・LLM なし・費用0）
//
// 2026-11-18 作業員K（統括役の付け忘れ防止の表「物件出しのブレインの6つ」の②・B）。
//   問題＝スタッフが画面で条件を直した番（property_condition_history の screen_edit）。正解＝直した欄と値（人が確かめた値）。
//   問いの文＝その直しの前24時間のお客様の発言（申込以降は使わない・伏せて写す）。
//   解く（決定論の段だけ）: ①入口の見分け（condition-source-gate）が条件の部分を残すか（物件の問い合わせと読み違えないか）
//                          ②種類の読み手（condition-reading）が直した欄の種類を拾うか
//   LLM の書き手（condition_brain・brain_bridge）は B-LLM として後で（DeepSeek・変えた時だけ）。
// 実行:
//   作る（DB を読む・JST 22時以降）: npx tsx --env-file=.env.local scripts/prop-exam-cond.ts --build [--days=120]
//   解く（DB を読まない）: npx tsx scripts/prop-exam-cond.ts --label=<名前> [--baseline=<前の名前>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { classifyConditionTurn } from "../app/lib/condition-source-gate";
import { readConditionStatements } from "../app/lib/condition-reading";
import { REACH_FIELDS } from "../app/lib/prop-brain-daily";

type Row = Record<string, any>;
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const repoRoot = (() => { const p = resolve(process.cwd()); const i = p.replace(/\\/g, "/").indexOf("/.claude/worktrees/"); return i >= 0 ? p.slice(0, i) : p; })();
const DIR = join(repoRoot, ".claude", "exam-cache", "prop-exam");
const PROBLEMS = join(DIR, "cond-problems.json");
/** 欄 → 種類（REACH_FIELDS の逆） */
const kindOfField = (f: string) => Object.entries(REACH_FIELDS).filter(([, fs]) => fs.includes(f)).map(([k]) => k);

async function build() {
  const { createClient } = await import("@supabase/supabase-js");
  const { maskPII } = await import("../app/lib/pii-mask"); // 伏せられない時は作らない（落ちる）
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(args.days ?? 120);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: edits } = await sb.from("property_condition_history").select("id, property_customer_id, changed_field, old_value, new_value, created_at, source_message_id").eq("source_message_id", "screen_edit").gte("created_at", since).order("id").limit(2000);
  const problems: Row[] = [];
  for (const h of (edits ?? []) as Row[]) {
    if (!kindOfField(h.changed_field).length) continue;
    const { data: conv } = await sb.from("conversations").select("id, is_post_apply").eq("property_customer_id", h.property_customer_id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!conv?.id || conv.is_post_apply) continue;
    const t = Date.parse(h.created_at);
    const { data: msgs } = await sb.from("messages").select("text, created_at").eq("conversation_id", conv.id).eq("sender", "customer").lt("created_at", h.created_at).gte("created_at", new Date(t - 864e5).toISOString()).order("created_at").limit(20);
    const text = ((msgs ?? []) as Row[]).map((m) => String(m.text ?? "")).filter(Boolean).join("\n");
    if (!text.trim()) continue;
    problems.push({ id: `c${h.id}`, field: h.changed_field, kinds: kindOfField(h.changed_field), oldValue: h.old_value, newValue: h.new_value, text: maskPII(text).slice(0, 1500) });
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PROBLEMS, JSON.stringify({ builtAt: new Date().toISOString(), days, problems }, null, 1));
  console.log(`問題 ${problems.length}（画面の直しの番・${days}日）→ ${PROBLEMS}`);
}

function solve() {
  if (!existsSync(PROBLEMS)) throw new Error(`問題が無い: ${PROBLEMS}（先に --build）`);
  const { problems } = JSON.parse(readFileSync(PROBLEMS, "utf8")) as { problems: Row[] };
  const per = problems.map((p) => {
    const turn = classifyConditionTurn(p.text);
    const kept = !!turn.conditionText;
    const kinds = kept ? readConditionStatements(turn.conditionText).map((x) => x.kind as string) : [];
    const hit = (p.kinds as string[]).some((k) => kinds.includes(k));
    return { id: p.id, field: p.field, kept, hit, turnKind: turn.kind };
  });
  const n = per.length;
  const pct = (a: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");
  const sum = { label: String(args.label ?? "now"), n, kept: per.filter((x) => x.kept).length, hit: per.filter((x) => x.hit).length };
  const byField = new Map<string, { n: number; hit: number }>();
  for (const x of per) { const b = byField.get(x.field) ?? { n: 0, hit: 0 }; b.n++; if (x.hit) b.hit++; byField.set(x.field, b); }
  console.log(`物件出しの試験 B（条件の読み取り・決定論）${sum.label}: 問題 ${n}・条件の部分が残る ${pct(sum.kept)}・直した欄の種類を拾う ${pct(sum.hit)}`);
  console.log(`  欄ごと: ${[...byField.entries()].map(([f, b]) => `${f} ${b.hit}/${b.n}`).join("・")}`);
  mkdirSync(join(DIR, "results"), { recursive: true });
  writeFileSync(join(DIR, "results", `cond-${sum.label}.json`), JSON.stringify({ ...sum, per }, null, 1));
  if (args.baseline) {
    const prev = JSON.parse(readFileSync(join(DIR, "results", `cond-${args.baseline}.json`), "utf8")) as { per: typeof per };
    const pm = new Map(prev.per.map((x) => [x.id, x]));
    const worse = per.filter((x) => pm.get(x.id)?.hit && !x.hit).map((x) => x.id);
    console.log(`前（${args.baseline}）と比べて: 悪くなった ${worse.length}${worse.length ? `（${worse.join(",")}）` : ""}`);
    if (worse.length) process.exitCode = 2;
  }
}

(async () => { if (args.build) await build(); else solve(); })().catch((e) => { console.error(e); process.exit(1); });
