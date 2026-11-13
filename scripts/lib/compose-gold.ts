// scripts/lib/compose-gold.ts — 文の要素の当たりと外れの根を、竹内さんの正解の番1番ずつで出す（読み込み・純関数・AI なし・DB なし）
//   2026-11-13 作業員10。scripts/audit-compose-roots.ts と scripts/compose-element-daily.ts が同じ物差しを使う。
//   根: A 考え方の土台が無い（設計図もブレインの欄も空）／B 細分化されていない（値は出たが竹内さんと違う）／C 材料が届いていない（ブレインは欄を持つのに設計図に来ない）／D 道・読みの誤りが文に流れた
//   KB 41dadfe6: 正解は竹内さんの番だけ（gold-*.json・名乗り「鈴木」の番は入れない）
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTurnUnderstanding, readSevenFields, buildSentencePlan, readComposeContext, planFieldsOf, type TakeuchiGold, type PlanFields } from "../../app/lib/compose-sentence-plan";
import { resolveReplyScene } from "../../app/lib/reply-scene";
import { buildComposeBrief, closingOfText } from "../../app/lib/compose-brief";
import { headWordOf, type HeadWord } from "../../app/lib/compose-head";
import { composeAsksFactsOn, asksFactsOf } from "../../app/lib/compose-asks-facts";

export type Root = "A" | "B" | "C" | "D";
export const ELEMENTS = ["主の役目", "頭", "つなぎ", "押さえ", "信頼", "潜在", "締め", "事実"] as const;
export type El = typeof ELEMENTS[number];
export type Prob = { id: string; customer?: string; staffText?: string; context?: Array<{ s: string; t: string; aix?: boolean }> };
export type ElementResult = { el: El; goldHas: boolean; hit: boolean; root: Root | null; ex: string; detail?: Record<string, string> };

export function loadGold(root: string, file: string): TakeuchiGold[] {
  return (JSON.parse(readFileSync(resolve(root, file), "utf8")) as { turns: TakeuchiGold[] }).turns;
}
export function loadProbs(root: string): Map<string, Prob> {
  return new Map((JSON.parse(readFileSync(join(root, "scripts/brain-exam/problems.json"), "utf8")) as Prob[]).map((p) => [p.id, p]));
}
/** 試験の答案の brain（この作業ツリーと横の作業ツリーの results の main-*.jsonl・14日以内・同じ問題は新しい答案） */
export function loadBrains(root: string, ids: ReadonlySet<string>, days = 14): Map<string, { at: string; brain: Record<string, unknown> }> {
  const out = new Map<string, { at: string; brain: Record<string, unknown> }>();
  const wt = resolve(root, "..");
  const dirs = [join(root, "scripts/brain-exam/results"), ...(() => { try { return readdirSync(wt).map((d) => join(wt, d, "scripts/brain-exam/results")); } catch { return []; } })()];
  const since = Date.now() - days * 86_400_000;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!/^main-.*\.jsonl$/.test(f)) continue;
      const p = join(d, f); if (statSync(p).mtimeMs < since) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.includes('"brain"')) continue;
        const m = line.match(/^\{"id":"(q\d+)"/); if (!m || !ids.has(m[1])) continue;
        try { const r = JSON.parse(line) as { id: string; at?: string; brain?: Record<string, unknown> }; if (!r.brain?.turn_contract) continue; const prev = out.get(r.id); if (!prev || (r.at ?? "") > prev.at) out.set(r.id, { at: r.at ?? "", brain: r.brain }); } catch { /* 壊れた行 */ }
      }
    }
  }
  return out;
}
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const has = (v: unknown) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
/** 道の誤り: ブレインの主の依頼が AIX・出し方が AIX なのに竹内さんは返信だけ */
export function pathWrong(b: Record<string, unknown>): boolean {
  const tc = obj(b.turn_contract); const asks = Array.isArray(tc?.asks) ? (tc!.asks as unknown[]).map(obj) : [];
  const lead = asks[typeof tc?.lead_with === "number" ? (tc.lead_with as number) : 0];
  return lead?.route === "aix" || b.reply_mode === "aix";
}
/** その要素の材料をブレインが持っているか */
export const SOURCE: Partial<Record<El, (b: Record<string, unknown>) => boolean>> = {
  主の役目: (b) => has(obj(b.turn_contract)?.asks) || has(b.turn_read),
  つなぎ: (b) => has(obj(b.seven_read)?.lead) || has(obj(b.appeal_timing)?.kind) || has(b.reply_direction),
  押さえ: (b) => has(obj(b.seven_read)?.point_how) || has(obj(b.judge_basis)?.key_point) || has(b.main_point),
  信頼: (b) => has(obj(b.seven_read)?.trust_how),
  潜在: (b) => has(b.latent_read) || has(b.three_layer) || has(b.customer_concern) || has(obj(b.customer_mindset)?.anxiety) || has(obj(b.seven_read)?.latent),
  事実: (b) => (Array.isArray(obj(b.turn_contract)?.asks) ? (obj(b.turn_contract)!.asks as unknown[]).some((a) => has(obj(a)?.part) || has(obj(a)?.answer)) : false) || has(obj(obj(b.turn_read)?.target)?.detail),
};
export function rootOfGold(el: El, goldHas: boolean, hit: boolean, planHas: boolean, b: Record<string, unknown>, fromTable = false): Root | null {
  if (!goldHas || hit) return null;
  if (pathWrong(b)) return "D";
  if (planHas || fromTable) return "B";
  return SOURCE[el]?.(b) ? "C" : "A";
}
/** 竹内さんの文の頭の一言（名前と挨拶の行を剥がした最初の文） */
const EMO = /[\u{1F300}-\u{1FAFF}☀-➿]/gu;
export function openerOfText(text: string): HeadWord {
  let L = String(text).normalize("NFKC").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  L = L.map((s) => s.replace(/^[^\s、。！!]{1,14}(?:さん|様)(?:達)?\s*/, "")).filter(Boolean);
  while (L.length && /^(?:お世話になっております|ご連絡(?:頂|いただ)きありがとうございます|夜分|こんにち|こんばん|おはよう)[^。]*$/.test(L[0].replace(EMO, "").replace(/[！!。]+$/, ""))) L.shift();
  const t = (L[0] || "").replace(EMO, "");
  if (!t) return "none";
  if (/^(?:[^。！!]{0,14})かしこまりました|^承知/.test(t)) return "kashikomari";
  if (/^はい/.test(t)) return "hai";
  if (/(?:頂き|いただき|下さり|くださり)?ありがとうございます/.test(t) && t.length <= 40) return "arigato";
  if (/^(?:全然)?大丈夫|^全然です/.test(t)) return "daijobu";
  return "none";
}
/** 1番の正解に、今の設計図・指示書・頭の木を当てる（どの要素が当たり・外れの根は何か） */
export function evalGoldTurn(g: TakeuchiGold, b: Record<string, unknown>, p: Prob): ElementResult[] {
  const customerText = String(p.customer ?? ""); const scene = resolveReplyScene({ customerText }).scene;
  const u = readTurnUnderstanding(b), s7 = readSevenFields(b);
  const plan = buildSentencePlan(u, s7, { scene, ctx: readComposeContext(b) });
  const f: PlanFields = planFieldsOf(u, s7, plan);
  const ex = (what: string) => `${g.id}「${customerText.replace(/\s+/g, " ").slice(0, 24)}」${what}`;
  const out: ElementResult[] = [];
  const push = (el: El, goldHas: boolean, hit: boolean, planHas: boolean, what: string, fromTable = false, detail?: Record<string, string>) => out.push({ el, goldHas, hit: goldHas && hit, root: rootOfGold(el, goldHas, hit, planHas, b, fromTable), ex: ex(what), detail });
  push("主の役目", true, f.mainRole === g.mainRole, !!f.mainRole, `竹内=${g.mainRole} 設計図=${f.mainRole ?? "空"}`);
  const leadHit = f.leadTo === g.leadTo && (g.bridgeRole == null || f.bridgeRole === g.bridgeRole);
  push("つなぎ", g.leadTo !== "none" || g.bridgeRole != null, leadHit, !!f.leadTo || !!f.bridgeRole, `竹内=${g.leadTo}/${g.bridgeRole ?? "-"} 設計図=${f.leadTo ?? "空"}/${f.bridgeRole ?? "-"}`);
  const gk = (g as unknown as { keyHow?: string[] }).keyHow ?? [], gt = (g as unknown as { trustHow?: string[] }).trustHow ?? [];
  const fromTable = plan.how?.src === "table";
  push("押さえ", gk.length > 0, gk.some((x) => (f.keyHow as string[]).includes(x)), f.keyHow.length > 0, `竹内=${gk.join("+")} 設計図=${f.keyHow.join("+") || "空"}${fromTable ? "（表）" : ""}`, fromTable);
  push("信頼", gt.length > 0, gt.some((x) => (f.trustHow as string[]).includes(x)), f.trustHow.length > 0, `竹内=${gt.join("+")} 設計図=${f.trustHow.join("+") || "空"}${fromTable ? "（表）" : ""}`, fromTable);
  push("潜在", g.latent != null, f.latent === g.latent, f.latent != null, `竹内=${g.latent} 設計図=${f.latent ?? "空"}`);
  // 事実の欄: 設計図の「どの部分」＋（COMPOSE_ASKS_FACTS=on の時）ブレインの依頼ごとの答え。竹内さんの「どの部分」の語の半分以上が入れば当たり
  const factText = [f.part ?? "", ...(composeAsksFactsOn() ? asksFactsOf(b).map((x) => x.text) : [])].join("／").replace(/^／+|／+$/g, "");
  const gw = [...new Set(String(g.part ?? "").normalize("NFKC").match(/[一-龯ァ-ヶーA-Za-z0-9]{2,}/gu) ?? [])];
  const factHit = !!factText && gw.length > 0 && gw.filter((w) => factText.normalize("NFKC").includes(w)).length * 2 >= gw.length;
  push("事実", !!g.part, factHit, !!factText, `竹内=${g.part} 設計図=${factText || "空"}`, false, { id: g.id, customer: customerText.slice(0, 160), takeuchiPart: g.part ?? "", takeuchi: String(p.staffText).slice(0, 240), asks: JSON.stringify(obj(b.turn_contract)?.asks ?? []).slice(0, 500) });
  // 頭: 頭の木（COMPOSE_HEAD_SPLIT の決め方）× 竹内さんの頭の一言。外れは型が粗い（B）
  const ctx = p.context ?? [];
  const prevStaff = [...ctx].reverse().find((m) => m.s === "staff") ?? null;
  const hw = headWordOf({ customerText, prev: prevStaff ? { text: prevStaff.t, aix: !!prevStaff.aix } : null }).word;
  const tw = openerOfText(String(p.staffText ?? ""));
  out.push({ el: "頭", goldHas: true, hit: hw === tw, root: hw === tw ? null : pathWrong(b) ? "D" : "B", ex: ex(`竹内=${tw} 木=${hw}`) });
  // 締め: 指示書の締め（決め表）× 竹内さんの文。誘導先が外れていれば C、誘いは合って結びだけ違えば A、誘いが違えば B
  const staff = ctx.filter((m) => m.s === "staff").map((m) => m.t);
  const brief = buildComposeBrief({ plan, s7, meta: b, scene, customerText, materialText: staff.slice(-3).join("\n"), recentStaffTexts: staff, firstContact: staff.length === 0 });
  const tk = closingOfText(String(p.staffText ?? "")), bc = brief.closing.name;
  const inviteT = /_cta$/.test(tk), inviteB = /_cta$/.test(bc);
  out.push({ el: "締め", goldHas: true, hit: tk === bc, root: tk === bc ? null : pathWrong(b) ? "D" : inviteT !== inviteB || (inviteT && tk !== bc) ? (leadHit ? "B" : "C") : "A", ex: ex(`竹内=${tk} 決め表=${bc}`) });
  return out;
}
