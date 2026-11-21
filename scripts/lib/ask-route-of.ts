// scripts/lib/ask-route-of.ts — 要件→行き先の型の純関数（scripts/audit-ask-route-takeuchi.ts が使う・テスト scripts/test-audit-ask-route.ts）・作業員M 2026-11-15
/** 要件の route の内訳（digest.tc "n:r1p0a1n0[:c][:w|:o]"） */
export function tcMix(tc: string | null | undefined): { r: number; p: number; a: number; n: number } | null {
  const m = /^(\d+):r(\d+)p(\d+)a(\d+)n(\d+)/.exec(String(tc ?? ""));
  return m ? { r: +m[2], p: +m[3], a: +m[4], n: +m[5] } : null;
}
/** 物件オススメ＋ピックアップは1つの束（オススメ1＋9 の型） */
export const aixBundleFamily = (k: string): string => (/property_send|property_recommend/.test(k) ? "物件の束" : k.split("/")[0]);
/** 竹内さんの通の並び（R=返信・A=AIX・同じ記号の連続はまとめる）と AIX の種類 */
export function sendShape(moves: ReadonlyArray<{ aix: boolean }>): string {
  const ks: string[] = [];
  for (const m of moves) { const k = m.aix ? "A" : "R"; if (ks[ks.length - 1] !== k) ks.push(k); }
  return ks.join("");
}
export function outlierOf(mix: { r: number; p: number; a: number } | null, shape: string, aixKinds: number): string {
  if (!mix) return "要件の記録なし";
  const sentAix = shape.includes("A");
  // 返信だけの要件なのに竹内さんは AIX だけ＝道の取り違え（AIX 側の取りこぼしより先に見る）
  if (mix.a === 0 && mix.p === 0 && mix.r > 0 && shape === "A") return "取り違え（返信→AIX）";
  if (sentAix && mix.a === 0 && mix.p === 0) return "取りこぼし（AIX 側）";
  if (aixKinds >= 2 && mix.a <= 1) return "取りこぼし（2つ目の AIX）";
  if (mix.a > 0 && !sentAix && mix.p === 0) return "取り違え（AIX→返信）";
  if (mix.r > 0 && mix.a > 0 && shape.length === 1) return "重ねの候補（1通で両方）";
  return "合う";
}


/**
 * 2026-11-18 統括役の割り当て（W46 の当たりの低い場面）: 外れの型を、竹内さんの決まり（CLAUDE.md の3つ）の原因に分ける目安（決定論・読んで直す前の初めの振り分け）。
 *   材料: ブレインの要件の記録が無い（材料が届いていない）／場面: 道は合っているが組・AIX の種類・1通に両方（場面や決まりの読み違い）／AIX: 返信か AIX かの取り違え
 */
export type CauseKind = "材料が届いていない" | "場面の読み違い" | "AIX の番の取り違え" | "合う";
export function causeOf(outlier: string): CauseKind {
  if (outlier.startsWith("合う")) return "合う";
  if (outlier.startsWith("要件の記録なし")) return "材料が届いていない";
  if (/取り違え|取りこぼし（AIX 側）/.test(outlier)) return "AIX の番の取り違え";
  return "場面の読み違い"; // 2つ目の AIX の席・重ねの候補・AIX の種類が違う
}
/** 道は合っているが AIX の種類が違う（ブレインの最終の AIX と竹内さんの AIX の束が違う） */
export function aixKindMismatch(brainAction: string | null | undefined, staffKinds: readonly string[]): boolean {
  const b = String(brainAction ?? "").split("/")[0].trim();
  if (!b || b === "null" || !staffKinds.length) return false;
  return !staffKinds.includes(aixBundleFamily(b));
}
/** 帳面の3つ（取りこぼし・重ね・取り違え）のどれか */
export function ledgerClassOf(outlier: string): "取りこぼし" | "重ね" | "取り違え" | "記録なし" | "合う" | "種類違い" {
  if (outlier.startsWith("合う")) return "合う";
  if (outlier.startsWith("要件の記録なし")) return "記録なし";
  if (outlier.startsWith("取りこぼし")) return "取りこぼし";
  if (outlier.startsWith("重ね")) return "重ね";
  if (outlier.startsWith("AIX の種類")) return "種類違い";
  return "取り違え";
}

/**
 * 2026-11-21 作業員M（台帳 #503・統括役の頼み・親 KB 6bb471bd「どの部分を返信で答え、どの部分を AIX で送るかを要件ごとに把握する」）:
 *   場面ごとに竹内さんの送り方の形を数え、過半数の形があれば設計知見の案（P2）、割れたら推奨つきの確認案にする（決まった計算・LLM なし）。
 */
export type SceneShapeVerdict =
  | { kind: "kb"; scene: string; n: number; top: string; share: number; second: string | null }
  | { kind: "ask"; scene: string; n: number; top: string; share: number; second: string | null; secondShare: number }
  | { kind: "few"; scene: string; n: number };
/** 竹内さんの番の送り方の形（R＝返信・A＝AIX の種類・1時間より後の AIX は「後で」）。例 "R"・"R→A:property_send"・"R→後でA:property_check_result" */
export function takeuchiShapeLabel(turnAt: number, moves: ReadonlyArray<{ at: number; aix: boolean }>, kinds: readonly string[]): string {
  const shape = sendShape(moves);
  const firstAix = moves.find((m) => m.aix);
  const later = !!firstAix && firstAix.at - turnAt > 60 * 60_000;
  const k = kinds.length ? kinds.slice(0, 2).join("+") : "?";
  let firstA = true;
  return shape.split("").map((c) => { if (c === "R") return "R"; if (firstA) { firstA = false; return `${later ? "後で" : ""}A:${k}`; } return "A"; }).join("→");
}
export function sceneShapeVerdict(scene: string, counts: ReadonlyMap<string, number>, o: { minN?: number; majority?: number } = {}): SceneShapeVerdict {
  const n = [...counts.values()].reduce((a, b) => a + b, 0);
  if (n < (o.minN ?? 5)) return { kind: "few", scene, n };
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const [top, tn] = sorted[0];
  const [second, sn] = sorted[1] ?? [null, 0];
  const share = tn / n;
  if (share > (o.majority ?? 0.5)) return { kind: "kb", scene, n, top, share, second };
  return { kind: "ask", scene, n, top, share, second, secondShare: sn / n };
}

/**
 * 2026-11-21 夜 作業員M（台帳 #405・内覧の誘いでブレインは AIX・竹内さんは返信）: 竹内さんが内覧の候補の日時（スタッフの予定）を手で打った返信は、AIX の中身を文で送った番
 *   （KB 8ee13967「人の文に AIX の中身（スタッフの予定）があれば、その番は AIX の番」）。aix-content-gate の網はこの日時の並びを拾わない（11/21 に確かめた）ので、ここで見る。
 *   例（伏せた形）「弊社直近ですと 本日18:00〜18:30 明日 12:00〜16:00 ご案内可能です！！」
 */
export const STAFF_SCHEDULE_RE = /(?:本日|明日|明後日|\d{1,2}\/\d{1,2}\s*[(（][^)）]{1,3}[)）])\s*\d{1,2}:\d{2}\s*[〜~～-]\s*\d{1,2}:\d{2}|ご案内(?:可能|出来|できます)/;
export function staffScheduleInText(text: string | null | undefined): boolean {
  return STAFF_SCHEDULE_RE.test(String(text ?? "").normalize("NFKC"));
}

/**
 * 2026-11-22 作業員M（台帳 #520「土台『要件』の本番の数字が無い」・統括役の分担: M が関数・combo-daily からの呼び出しと quality_daily は N2）:
 *   番1つの材料から、要件の帳面の外れ（取りこぼし・重ね・取り違え・合う）を決める。scripts/audit-ask-route-takeuchi.ts と同じ数え方・同じ読み替え3つ:
 *     ① 要件に AIX が無くても、ブレインの最終の AIX が竹内さんの AIX と同じ束なら合う（前の約束を果たす AIX＝要件の外）
 *     ② 1時間より後の最初の AIX は前の約束の果たし（番の外）
 *     ③ 内覧の誘い・待ち合わせの AIX の番に竹内さんが候補の日時を手で打った返信は AIX の中身の手打ち（KB 8ee13967）
 *   aixFamily は呼ぶ側の AIX の種類の束ね（audit と同じ aixBundleFamily を渡す）。
 */
export type AskTurnInput = {
  tc: string | null | undefined;
  turnAt: number;
  moves: ReadonlyArray<{ at: number; aix: boolean; text?: string | null }>;
  /** 竹内さんの AIX の種類（束ねた後・重なりなし） */
  kinds: readonly string[];
  brainAction: string | null | undefined;
};
export type AskTurnClass = "取りこぼし" | "重ね" | "取り違え" | "合う" | "記録なし" | "種類違い";
export function askTurnOutlier(i: AskTurnInput): string {
  const mix = tcMix(i.tc);
  const shape = sendShape(i.moves);
  let o = outlierOf(mix, shape, i.kinds.length);
  if (o === "取りこぼし（AIX 側）" && i.brainAction && i.kinds.length && !aixKindMismatch(i.brainAction, i.kinds)) o = "合う（AIX は要件の外＝前の約束を果たす）";
  const firstAix = i.moves.find((m) => m.aix);
  if (o === "取りこぼし（AIX 側）" && firstAix && firstAix.at - i.turnAt > 60 * 60_000) o = "合う（AIX は1時間より後＝前の約束の果たし・番の外）";
  if (o === "合う" && shape.includes("A") && aixKindMismatch(i.brainAction, i.kinds)) o = "AIX の種類が違う";
  if (o === "取り違え（AIX→返信）" && /^(?:viewing_invite|meeting_place)/.test(String(i.brainAction ?? "")) && i.moves.some((m) => !m.aix && staffScheduleInText(m.text))) o = "合う（竹内さんは AIX の中身＝予定を手で打った・8ee13967）";
  return o;
}
export function askTurnClass(i: AskTurnInput): AskTurnClass { return ledgerClassOf(askTurnOutlier(i)); }
/** 番の分けをまとめて quality_daily の4つの数に（記録なしは分母に入れない）。名前は growth:ask:取りこぼし／重ね／取り違え／合う（%） */
export function askDailyCounts(classes: readonly AskTurnClass[]): { n: number; 取りこぼし: number; 重ね: number; 取り違え: number; 種類違い: number; 合う: number; 合う率: number | null } {
  const c = { 取りこぼし: 0, 重ね: 0, 取り違え: 0, 種類違い: 0, 合う: 0 };
  for (const k of classes) if (k !== "記録なし") c[k]++;
  const n = c.取りこぼし + c.重ね + c.取り違え + c.種類違い + c.合う;
  return { n, ...c, 合う率: n ? Math.round((c.合う / n) * 1000) / 10 : null };
}
