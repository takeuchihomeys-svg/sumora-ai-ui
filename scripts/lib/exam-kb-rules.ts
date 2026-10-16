// scripts/lib/exam-kb-rules.ts — 設計知見（KB）のうち決まりで判定できる物を、試験の費用0の採点に足す口（LLM を呼ばない）
//
// 2026-10-16 竹内「試験と設計知見を連動させる」④: 知見を採点の物差しにする。全部はやらない＝口と2例。
//   規則は「どの知見（id）から来たか」を持つ。試験の結果に違反を知見の id と一緒に出す（どの決まりに反したかが見える）。
//   既定は表示だけ（合否に入れない）。合否に入れる: --kb-rules=score（下書きの合格を落とす）。止める: --kb-rules=off
export type KbRuleCtx = { contextText: string; pcText: string };
export type KbRule = { kbId: string; name: string; check: (draft: string, ctx: KbRuleCtx) => string | null };
export type KbRuleHit = { kbId: string; name: string; why: string };

const STATION_RE = /([ぁ-んァ-ヶ一-龠々ーA-Za-z]{1,10})駅/g;
/** 駅の名前の前の言葉（「最寄り」「各」等は駅の名前ではない） */
const NOT_STATION = /^(?:最寄|最寄り|各|同|当|この|その|両|始発|ターミナル|近く|主要|複数|大きい|乗換|乗り換え|の)$/;

export const KB_RULES: ReadonlyArray<KbRule> = [
  {
    // 015f2950: 駅の名前を書くのはスタッフが送った文・売上サポ（条件の行）に駅がある時だけ（読みだけの駅は書かない）
    kbId: "015f2950-9bff-4396-9b85-98876b2f18a7",
    name: "駅の名前は確かめた出どころだけ",
    check: (draft, ctx) => {
      const src = `${ctx.contextText}\n${ctx.pcText}`;
      const bad = new Set<string>();
      for (const m of draft.matchAll(STATION_RE)) {
        // 漢字・カタカナで終わる時は最後の平仮名より後ろだけ（助詞・「近くの」等を外す。「清水が丘」のように短く切れたら下の2字未満で見ない＝誤爆より見逃し）。
        //   「なんば」のような平仮名だけの駅はそのまま
        const nm = /[一-龠々ァ-ヶーA-Za-z]$/.test(m[1]) ? (m[1].match(/[一-龠々ァ-ヶーA-Za-z]+$/)?.[0] ?? m[1]) : m[1];
        if (nm.length < 2 || NOT_STATION.test(nm)) continue;
        if (!src.includes(nm)) bad.add(`${nm}駅`);
      }
      return bad.size ? `会話・条件の行に無い駅の名前: ${[...bad].join("・")}` : null;
    },
  },
  {
    // d94a966c（015f2950 の③）: 相場より安いと言うのは根拠（相場の材料）がある時だけ。相場並み・高い時は言わない
    kbId: "d94a966c-e835-4716-89f2-63bcb9b00564",
    name: "相場は根拠がある時だけ",
    check: (draft, ctx) => {
      if (!/相場(?:より|と比べ|以下|並|的に|から見)/.test(draft)) return null;
      return /相場/.test(`${ctx.contextText}\n${ctx.pcText}`) ? null : "相場の材料（会話・条件の行）が無いのに相場と比べている";
    },
  },
];

export function kbRulesMode(arg: string | undefined, env: Record<string, string | undefined> = process.env): "show" | "score" | "off" {
  const v = String(arg || env.EXAM_KB_RULES || "show").trim().toLowerCase();
  return v === "score" ? "score" : v === "off" ? "off" : "show";
}
export function checkKbRules(draft: string, ctx: KbRuleCtx, rules: ReadonlyArray<KbRule> = KB_RULES): KbRuleHit[] {
  const out: KbRuleHit[] = [];
  for (const r of rules) { const w = r.check(draft, ctx); if (w) out.push({ kbId: r.kbId, name: r.name, why: w }); }
  return out;
}
