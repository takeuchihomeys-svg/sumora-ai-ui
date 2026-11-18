// scripts/prop-exam-cond.ts — 物件出しの試験 B: 条件の読み取り（決定論の段・LLM なし・費用0）
//
// 2026-11-18 作業員K（統括役の付け忘れ防止の表「物件出しのブレインの6つ」の②・B）。
//   問題は3つの段（金＝スタッフが画面で直した番・手＝11/15 に目で読んだ読み違いの型・銀＝自動で書いた値が14日残った番＝参考）。下の HAND_PROBLEMS と build を見る。
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
import { classifyByKeywords } from "../app/lib/condition-intent";

type Row = Record<string, any>;
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const repoRoot = (() => { const p = resolve(process.cwd()); const i = p.replace(/\\/g, "/").indexOf("/.claude/worktrees/"); return i >= 0 ? p.slice(0, i) : p; })();
const DIR = join(repoRoot, ".claude", "exam-cache", "prop-exam");
const PROBLEMS = join(DIR, "cond-problems.json");
/** 欄 → 種類（REACH_FIELDS の逆） */
const kindOfField = (f: string) => Object.entries(REACH_FIELDS).filter(([, fs]) => fs.includes(f)).map(([k]) => k);

// ── 問題の3つの段（統括役 11/18 の決め）──
//   gold … スタッフが画面で直した番（人が確かめた正解）
//   hand … 11/15 に目で読んだ読み違いの型をそのまま問題にした物（人が書いた正解・下の HAND_PROBLEMS）
//   silver … 自動の書き手が書いた値が14日間変わらず残った番（誰も直さなかっただけの誤りが混ざる＝傾きを見る参考だけ）
//   悪化0の判断は gold と hand で決め、silver は数えて並べるだけ
type Tier = "gold" | "silver" | "hand";
type Problem = { id: string; tier: Tier; field: string; kinds: string[]; text: string; expectKept?: boolean; expectIntentNot?: string; knownGap?: string; note?: string };

/** 11/15 に目で読んだ型（伏せた文・物件名は残す） */
export const HAND_PROBLEMS: Problem[] = [
  { id: "h-same-cond-3dk", tier: "hand", field: "floor_plan", kinds: ["間取り"], text: "ご提案ありがとうございます。\nちなみに同じ条件で間取りが3DKのものはございますでしょうか。", expectKept: true, expectIntentNot: "REPLACE", note: "「同じ条件で3DKは」は足す（2LDK以上を3DKに置き換えない）" },
  { id: "h-size-soft", tier: "hand", field: "floor_area_min", kinds: [], text: "出来れば35㎡超えてれば嬉しいです、なければ全然小さくても大丈夫です！", expectKept: true, knownGap: "広さの要望の強さ（できれば）を読む部品が無い（requirement-strength は入居・ペット・家賃・エリアだけ）・広さの種類は条件の届きの表にも無い", note: "できればの広さを必須の下限にしない" },
  { id: "h-room-tag", tier: "hand", field: "other_requests", kinds: [], text: "Ｆ ａｓｅｃｉａ Ｒｕｍｉｎａ（3階/304/1LDK/30.58m²） こちらもお願いします！立て続けで申し訳ありません", expectKept: false, note: "部屋の札つきの物件の問い合わせは条件にしない" },
  { id: "h-prop-cost-q", tier: "hand", field: "other_requests", kinds: [], text: "ルディシアコートの初期費用知りたいです！", expectKept: false, note: "1件の物件の質問は条件にしない" },
  { id: "h-past-liked", tier: "hand", field: "other_requests", kinds: [], text: "こちらも過去気になっていた物件です、\n①ジーメゾン角田ラシード 3階建\n②クリエオーレ吉田下島 3階建", expectKept: false, note: "過去に気になっていた物件の並びは条件にしない" },
];

const AUTO = /^(format|p4|brain_bridge|condition_brain|path_c)/;
async function build() {
  const { createClient } = await import("@supabase/supabase-js");
  const { maskPII } = await import("../app/lib/pii-mask"); // 伏せられない時は作らない（落ちる）
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const days = Number(args.days ?? 120);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: rows } = await sb.from("property_condition_history").select("id, property_customer_id, changed_field, old_value, new_value, created_at, source_message_id").gte("created_at", since).order("id").limit(10000);
  const hist = (rows ?? []) as Row[];
  const byPc = new Map<string, Row[]>(); for (const h of hist) { const k = String(h.property_customer_id); if (!byPc.has(k)) byPc.set(k, []); byPc.get(k)!.push(h); }
  const problems: Problem[] = [...HAND_PROBLEMS];
  const convOf = new Map<string, Row | null>();
  const textBefore = async (pc: string, atIso: string, msgId: string | null): Promise<string> => {
    if (!convOf.has(pc)) { const { data } = await sb.from("conversations").select("id, is_post_apply").eq("property_customer_id", pc).order("updated_at", { ascending: false }).limit(1).maybeSingle(); convOf.set(pc, (data as Row | null) ?? null); }
    const conv = convOf.get(pc); if (!conv?.id || conv.is_post_apply) return "";
    if (msgId) { const { data } = await sb.from("messages").select("text").eq("id", msgId).maybeSingle(); return String((data as Row | null)?.text ?? ""); }
    const t = Date.parse(atIso);
    const { data: msgs } = await sb.from("messages").select("text").eq("conversation_id", conv.id).eq("sender", "customer").lt("created_at", atIso).gte("created_at", new Date(t - 864e5).toISOString()).order("created_at").limit(20);
    return ((msgs ?? []) as Row[]).map((m) => String(m.text ?? "")).filter(Boolean).join("\n");
  };
  for (const h of hist) {
    const src = String(h.source_message_id ?? "");
    const kinds = kindOfField(h.changed_field); if (!kinds.length) continue;
    let tier: Tier | null = null;
    if (src === "screen_edit") tier = "gold";
    else if (AUTO.test(src)) {
      const t = Date.parse(h.created_at);
      if (Date.now() - t < 14 * 864e5) continue;
      const later = (byPc.get(String(h.property_customer_id)) ?? []).some((x) => x.id !== h.id && x.changed_field === h.changed_field && Date.parse(x.created_at) > t && Date.parse(x.created_at) <= t + 14 * 864e5);
      if (!later) tier = "silver";
    }
    if (!tier) continue;
    const msgId = tier === "silver" ? (src.split(":")[1] || null) : null;
    const text = await textBefore(String(h.property_customer_id), h.created_at, msgId);
    if (!text.trim()) continue;
    problems.push({ id: `${tier === "gold" ? "g" : "s"}${h.id}`, tier, field: h.changed_field, kinds, text: maskPII(text).slice(0, 1500), expectKept: true });
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PROBLEMS, JSON.stringify({ builtAt: new Date().toISOString(), days, problems }, null, 1));
  const c = (t: Tier) => problems.filter((p) => p.tier === t).length;
  console.log(`問題 ${problems.length}（金 ${c("gold")}・手 ${c("hand")}・銀 ${c("silver")}・${days}日）→ ${PROBLEMS}`);
}

function solve() {
  if (!existsSync(PROBLEMS)) throw new Error(`問題が無い: ${PROBLEMS}（先に --build）`);
  const loaded = JSON.parse(readFileSync(PROBLEMS, "utf8")) as { problems: Problem[] };
  // 手の問題はいつも今の表から（ファイルが古くても）
  const problems = [...HAND_PROBLEMS, ...loaded.problems.filter((p) => p.tier !== "hand")];
  const per = problems.map((p) => {
    const turn = classifyConditionTurn(p.text);
    const kept = !!turn.conditionText;
    const kinds = kept ? readConditionStatements(turn.conditionText).map((x) => x.kind as string) : [];
    const keptOk = p.expectKept == null || kept === p.expectKept;
    const kindOk = !p.kinds.length || !kept || p.kinds.some((k) => kinds.includes(k));
    const intent = p.expectIntentNot ? classifyByKeywords(p.text, null)?.intent ?? null : null;
    const intentOk = !p.expectIntentNot || intent !== p.expectIntentNot;
    const pass = keptOk && kindOk && intentOk && !p.knownGap;
    return { id: p.id, tier: p.tier, field: p.field, pass, keptOk, kindOk, intentOk, knownGap: !!p.knownGap, turnKind: turn.kind };
  });
  const sum = { label: String(args.label ?? "now"), tiers: {} as Record<string, { n: number; pass: number }> };
  for (const t of ["gold", "hand", "silver"] as const) { const xs = per.filter((x) => x.tier === t); sum.tiers[t] = { n: xs.length, pass: xs.filter((x) => x.pass).length }; }
  const f = (t: string) => `${sum.tiers[t].pass}/${sum.tiers[t].n}`;
  console.log(`物件出しの試験 B（条件の読み取り・決定論）${sum.label}: 金 ${f("gold")}・手 ${f("hand")}（分かっている穴 ${per.filter((x) => x.knownGap).length}）・銀 ${f("silver")}（参考）`);
  for (const x of per.filter((x) => x.tier !== "silver" && !x.pass)) console.log(`  外れ ${x.id}（${x.tier}・${x.field}）: ${x.knownGap ? "分かっている穴" : [!x.keptOk && "入口の見分け", !x.kindOk && "種類", !x.intentOk && "置き換えと読んだ"].filter(Boolean).join("・")}`);
  mkdirSync(join(DIR, "results"), { recursive: true });
  writeFileSync(join(DIR, "results", `cond-${sum.label}.json`), JSON.stringify({ ...sum, per }, null, 1));
  if (args.baseline) {
    const prev = JSON.parse(readFileSync(join(DIR, "results", `cond-${args.baseline}.json`), "utf8")) as { per: typeof per };
    const pm = new Map(prev.per.map((x) => [x.id, x]));
    const worse = per.filter((x) => x.tier !== "silver" && pm.get(x.id)?.pass && !x.pass).map((x) => x.id);
    const silverWorse = per.filter((x) => x.tier === "silver" && pm.get(x.id)?.pass && !x.pass).length;
    console.log(`前（${args.baseline}）と比べて: 悪くなった（金・手）${worse.length}${worse.length ? `（${worse.join(",")}）` : ""}・銀の悪くなった ${silverWorse}（参考）`);
    if (worse.length) process.exitCode = 2;
  }
}

(async () => { if (args.build) await build(); else solve(); })().catch((e) => { console.error(e); process.exit(1); });
