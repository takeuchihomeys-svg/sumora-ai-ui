// app/lib/conductor-near-opinion.ts — 入口の意見: 近い竹内さんの番の多数の一手を、その番の要約と1組でブレインの材料に渡す（純関数・DB/LLM なし）
//
// 2026-11-07 作業員4（弱い所 270・271・統括役の決め）:
//   270: 入口の統括の読みは記録だけで、ブレインの材料に何も渡していなかった。271: 近い番の表（conductor_turn_vectors）を、ブレインの手前で読む所が無かった。
//   KB dc0d77cf（11/06 実測・竹内さんの番 1,030）: 自己申告の自信より「近い竹内さんの番の束（距離0.2以内に5件以上）の過半数の割合」の方が当たりと揃う
//     （0.8以上 83%・0.65〜0.8 72%・0.5〜0.65 57%）。0.8以上は KB 75da346a（20件・8割）の決める側の線に届く。
//   KB P0 575a7cd5 ④: ベクトルは数の重みではなく、竹内さんの近い過去の番で何をしたかを引くために使う。
//   KB e786394e: 割合（読み）だけの材料はブレインを動かさない（11/06 に3回）。竹内さんの一手（返信／AIX【〇〇】）と、その番の要約・竹内さんの実際の文を1組で渡す。
//   決めるのはブレイン。この1行は意見で、この番の材料と食い違えば材料を採る（理由は reason に）。
//   切替: CONDUCTOR_NEAR_OPINION=on（既定 off）。線: 束 0.2・5件以上・過半数の割合 0.8 以上の時だけ（それ未満は何も渡さない）
// テスト: app/lib/__tests__/conductor-near-opinion.test.ts

type Env = Record<string, string | undefined>;
export const nearOpinionOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_NEAR_OPINION ?? "").trim().toLowerCase() === "on";

export const NEAR_OPINION_BAND = 0.2;
export const NEAR_OPINION_MIN_N = 5;
export const NEAR_OPINION_MIN_SHARE = 0.8;

export type NearTurnRow = { key: string; distance: number; route: "aix" | "reply"; aix: string | null; picker?: string | null; situation?: string | null; focus?: string | null };
/** replyFocus: 返信の側の竹内さんの重点の多数（v2 の focus・11/07 統括役の決め「一手の名前を返信の種類まで」）。分からなければ null */
export type NearOpinion = { move: "返信" | "AIX"; aix: string | null; share: number; n: number; agree: number; exemplar: NearTurnRow; replyFocus?: string | null };

// 2026-11-07 作業員4（試験 nop3-on2: 「返信」とだけ言うと、約束の 2段:pickup がブレインの中で素の返信に寄った＝q362・q367 の本質が ✕）:
//   返信の種類を v2 の重点（conductor-focus.FOCUS_KINDS）で名前にする。約束の文は turn_contract の route=promise と並べて言う
export const REPLY_KIND_LABEL: Record<string, string> = {
  promise_make: "返信（確かめる・探してお送りする約束の文＝2段の約束・turn_contract の route は promise）",
  promise_keep: "返信（約束の結果を伝える文）",
  answer: "返信（聞かれた事に本文で答える）",
  ease: "返信（不安を消す文）",
  close: "返信（内覧・申込へ誘う文）",
  propose: "返信（次の一手・物件や条件を出す文）",
  relation: "返信（受け止めて関係を続ける文）",
};

/** 近い番から多数の一手（返信か AIX か）を1つ。束の中が minN 未満・割合が minShare 未満なら null（意見を出さない） */
export function nearOpinion(rows: ReadonlyArray<NearTurnRow>, o: { band?: number; minN?: number; minShare?: number } = {}): NearOpinion | null {
  const band = o.band ?? NEAR_OPINION_BAND, minN = o.minN ?? NEAR_OPINION_MIN_N, minShare = o.minShare ?? NEAR_OPINION_MIN_SHARE;
  const inside = rows.filter((r) => Number.isFinite(r.distance) && r.distance <= band).sort((a, b) => a.distance - b.distance);
  if (inside.length < minN) return null;
  const aixN = inside.filter((r) => r.route === "aix").length, replyN = inside.length - aixN;
  const move: "返信" | "AIX" = aixN > replyN ? "AIX" : "返信";
  const agree = Math.max(aixN, replyN);
  const share = Math.round((agree / inside.length) * 100) / 100;
  if (share < minShare) return null;
  const same = inside.filter((r) => (move === "AIX" ? r.route === "aix" : r.route === "reply"));
  // AIX の側は、その中で一番多い種類（同数なら近い方）
  let aix: string | null = null;
  if (move === "AIX") {
    const c = new Map<string, number>();
    for (const r of same) c.set(r.aix ?? "aix_unknown", (c.get(r.aix ?? "aix_unknown") ?? 0) + 1);
    aix = [...c.entries()].sort((a, b) => b[1] - a[1] || same.findIndex((r) => (r.aix ?? "aix_unknown") === a[0]) - same.findIndex((r) => (r.aix ?? "aix_unknown") === b[0]))[0][0];
  }
  // 返信の側は、その中で一番多い重点（同数なら近い方・分からない行は数えない）
  let replyFocus: string | null = null;
  if (move === "返信") {
    const known = same.filter((r) => !!r.focus && !!REPLY_KIND_LABEL[r.focus]);
    if (known.length) {
      const c = new Map<string, number>();
      for (const r of known) c.set(r.focus!, (c.get(r.focus!) ?? 0) + 1);
      replyFocus = [...c.entries()].sort((a, b) => b[1] - a[1] || known.findIndex((r) => r.focus === a[0]) - known.findIndex((r) => r.focus === b[0]))[0][0];
    }
  }
  const exemplar = (move === "AIX" ? same.find((r) => (r.aix ?? "aix_unknown") === aix) : (replyFocus ? same.find((r) => r.focus === replyFocus) : same[0])) ?? same[0];
  return { move, aix, share, n: inside.length, agree, exemplar, replyFocus };
}

/** 状況の文（turnSituationText の形）から、お客様の発言の部分だけを短く（伏せ済みの文だけを渡す） */
export function situationGist(situation: string | null | undefined, max = 60): string {
  if (!situation) return "";
  const cust = /お客様:\s*([\s\S]*)$/.exec(situation)?.[1] ?? "";
  const scene = /場面:\s*(.+)/.exec(situation)?.[1]?.trim() ?? "";
  const c = cust.replace(/\s+/g, " ").trim();
  return `${scene ? `［${scene}］` : ""}${c.length > max ? c.slice(0, max) + "…" : c}`;
}

/** ブレインの材料の1行（意見が無ければ ""）。takeuchiText は伏せ済みの竹内さんの実際の最初の文（無ければ省く） */
export function nearOpinionLine(op: NearOpinion | null, takeuchiText?: string | null): string {
  if (!op) return "";
  const moveLabel = op.move === "AIX" ? `AIX【${op.aix ?? "aix_unknown"}】` : (op.replyFocus && REPLY_KIND_LABEL[op.replyFocus]) || "返信";
  const gist = situationGist(op.exemplar.situation);
  const t = (takeuchiText ?? "").replace(/\s+/g, " ").trim();
  const tt = t ? `・竹内さんの実際の文「${t.length > 70 ? t.slice(0, 70) + "…" : t}」` : "";
  return `【入口の意見・近い竹内さんの番（11/07）】この番に近い竹内さんの過去の番 ${op.n}件のうち ${op.agree}件（${Math.round(op.share * 100)}%）で、竹内さんの最初の一手は ${moveLabel}。一番近い番: お客様「${gist || "（要約なし）"}」→ 竹内さんは ${moveLabel}${tt}。この割合の時、竹内さんと同じ一手は約8割当たる（過去の番で実測）。この番の材料（送った物・約束・確認の結果）と食い違わなければ同じ一手を採り、食い違う時は材料を採って reason にその理由を書く。`;
}

/** digest の1語（例 "AIX:property_send:6:0.83" / "返信:5:1"）。意見なしは "-" */
export const nearOpinionDigest = (op: NearOpinion | null) => (op ? `${op.move === "AIX" ? `AIX:${op.aix}` : `返信${op.replyFocus ? `/${op.replyFocus}` : ""}`}:${op.n}:${op.share}` : "-");
