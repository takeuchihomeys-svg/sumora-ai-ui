// scripts/lib/staff-added-phrases.ts — スタッフが毎回足す一言の型（台帳 #815・純関数・LLM なし）
// 2026-11-27 作業員L（統括役の頼み・設計知見 2ac1b4b9 竹内さんの決定 10/20「AI の下書きと実際に送った文を比べ、足した細かい一言を型で数え、省かれている所を直す」・
//   3eb5ed5b「消された言い回しと足された言い回しの両方で見る」）: 実送信にあって下書きに無い一言だけを数える（下書きにも同じ型があれば足したと数えない）。
//   型は edited-turn-miner の語の網（挨拶・締め・確認の約束・誘い）に、受け止め・名前・サポートの一言・ご査収のお礼・期日・共感 を足した物。
export type PhraseKind = "ack" | "name" | "support" | "satisa" | "deadline" | "greeting" | "close" | "empathy" | "check_promise" | "appeal";
export const PHRASE_JA: Record<PhraseKind, string> = {
  ack: "受け止め（かしこまりました・承知しました）", name: "名前の呼びかけ（〇〇さん）", support: "サポートの一言（お力に・お手伝い）",
  satisa: "ご査収のお礼", deadline: "期日の一言（本日中・明日まで 等）", greeting: "挨拶（お世話になっております）",
  close: "締め（よろしくお願い・何卒・お気軽に）", empathy: "共感（残念・嬉しい・ご不安）", check_promise: "確認の約束", appeal: "内覧・申込の誘い",
};
const N = (s: string) => String(s ?? "").normalize("NFKC");
const RE: Record<PhraseKind, RegExp> = {
  ack: /かしこまりました|承知(?:いた|致)?しました|了解(?:いた|致)?しました/,
  name: /^[^。！!\s]{1,14}(?:さん|様)(?:[、,！!]|$)/m,
  support: /サポート|お力に|お手伝い|お任せ(?:下さい|ください)|尽力/,
  satisa: /ご査収/,
  deadline: /(?:本日|明日|明後日|今週|来週|今月|週末|[0-9０-９]{1,2}日|午前|午後|夕方)(?:中|まで|迄|頃|には)/,
  greeting: /お世話になっております|はじめまして/,
  close: /よろしくお願い|何卒|お気軽に|お申し付け/,
  empathy: /残念|嬉しい|嬉しく|楽しみ|ご不安|ご心配|大変でしたね|お疲れ様/,
  check_promise: /確認(?:させて|致し|いたし|して|し(?:ご連絡|次第|て)|出来次第)|お調べ|問い合わせ/,
  appeal: /内覧|ご案内|お申込|お申し込み/,
};
/** 文の中の型（純関数） */
export function phraseKindsOf(text: string): PhraseKind[] {
  const t = N(text);
  return (Object.keys(RE) as PhraseKind[]).filter((k) => RE[k].test(t));
}
/** 足した一言の型（純関数）: 実送信にあって下書きに無い型 */
export function addedPhraseKinds(draft: string, sent: string): PhraseKind[] {
  if (!String(sent ?? "").trim() || !String(draft ?? "").trim()) return [];
  const d = new Set(phraseKindsOf(draft));
  return phraseKindsOf(sent).filter((k) => !d.has(k));
}
export type TurnIn = { scene: string; writer: "takeuchi" | "staff"; draft: string; sent: string };
export type PhraseRow = { scene: string; kind: PhraseKind; who: "竹内さん" | "全員"; added: number; turns: number; share: number };
/** 場面×一言の型×足した割合（純関数）。竹内さん本人の番と全員を分ける。番が minTurns 未満の場面は出さない */
export function phraseTable(turns: readonly TurnIn[], minTurns = 5): PhraseRow[] {
  const out: PhraseRow[] = [];
  const groups: Array<["竹内さん" | "全員", readonly TurnIn[]]> = [["竹内さん", turns.filter((t) => t.writer === "takeuchi")], ["全員", turns]];
  for (const [who, ts] of groups) {
    const byScene = new Map<string, TurnIn[]>();
    for (const t of ts) { const a = byScene.get(t.scene) ?? []; a.push(t); byScene.set(t.scene, a); }
    for (const [scene, xs] of byScene) {
      if (xs.length < minTurns) continue;
      const cnt = new Map<PhraseKind, number>();
      for (const t of xs) for (const k of addedPhraseKinds(t.draft, t.sent)) cnt.set(k, (cnt.get(k) ?? 0) + 1);
      for (const [kind, added] of cnt) out.push({ scene, kind, who, added, turns: xs.length, share: Math.round((added / xs.length) * 1000) / 10 });
    }
  }
  return out.sort((a, b) => b.share - a.share || b.added - a.added);
}
