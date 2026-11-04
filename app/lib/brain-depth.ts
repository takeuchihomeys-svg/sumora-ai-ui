// app/lib/brain-depth.ts — 統括の③「どこまで深く読むか」を番ごとに決める（純関数・まずは記録だけ）
//
// 2026-10-29 竹内さんの答え③「軽い番は前の判断の引き継ぎと安い AI・送れる物の確かめは残す」・10/28「深く読む部分なら深く読むなどの判断を強化」。
// 学び（project_brain_weaknesses）: 「速く・じっくり」を全部の番に一律で試して効かなかった → 深さは場面と状態で決める。
// 第1段（この版）: 深さと理由を毎回ログ（brain:depth）に残すだけ。判断・費用は変えない。数えてから（浅すぎ＝材料が届かない外れ／深すぎ＝読み直しの費用）
//   軽い番の引き継ぎ（LLM を安い物にする・呼ばない）を次の段で入れる。テスト: app/lib/__tests__/brain-depth.test.ts
export type BrainDepth = "light" | "normal" | "deep";
export type DepthInput = {
  /** 今のお客様の連投の文 */
  turnText: string;
  /** スタンプ・画像だけ（文字が無い） */
  stampOnly: boolean;
  /** お礼・了承だけ（問い・依頼が無い） */
  ackOnly: boolean;
  /** 前のこちらの通が締め（ご検討・何卒・新着が出次第 等） */
  closedBefore: boolean;
  /** 売上サポに送れる新しい候補がある（ある時は軽くしない＝送れる物の確かめは残す） */
  pickupReady: boolean | null;
  /** こちらのまだ果たしていない約束の数 */
  openPromises: number;
  /** 前のお客様の通からの空き（時間） */
  gapHours: number | null;
};

const DEEP_WORDS: ReadonlyArray<[string, RegExp]> = [
  ["申込", /申込|申し込|契約/],
  ["審査", /審査|保証人|名義|在籍確認/],
  ["費用の不満", /高い|高すぎ|安く(?:なら|でき)|値引|割引|予算(?:オーバー|を超)/],
  ["条件の言い直し", /(?:やっぱり|やはり|でも大丈夫|じゃなくても|に変え|変更|広げ|上げても)/],
  ["キャンセル・断り", /キャンセル|やめ(?:ます|とき)|見送|他で決め|他社/],
];

export function decideBrainDepth(i: DepthInput): { depth: BrainDepth; reason: string } {
  const t = String(i.turnText ?? "").normalize("NFKC");
  const deep = DEEP_WORDS.find(([, re]) => re.test(t));
  if (deep) return { depth: "deep", reason: deep[0] };
  const asks = (t.match(/[?？]/g) ?? []).length + (t.match(/(?:ますか|ですか|でしょうか|ください|下さい|ほしい|欲しい)/g) ?? []).length;
  if (asks >= 2) return { depth: "deep", reason: "複数の依頼" };
  if (i.gapHours !== null && i.gapHours >= 24 * 7) return { depth: "deep", reason: "久しぶりの連絡" };
  if (i.openPromises > 0 && !i.ackOnly && !i.stampOnly) return { depth: "deep", reason: "約束の結果待ちの番" };
  if ((i.stampOnly || i.ackOnly) && i.closedBefore && !i.pickupReady && i.openPromises === 0) return { depth: "light", reason: i.stampOnly ? "締めの後のスタンプ" : "締めの後の短いお礼" };
  if (i.ackOnly && Array.from(t.trim()).length <= 20 && !i.pickupReady) return { depth: "light", reason: "短いお礼・了承" };
  return { depth: "normal", reason: "一般" };
}

// ── 第2段（2026-11-05 作業員4・竹内さんの決定 KB P1 077d6e18「深く読むのは複雑な番だけ」）──────────────────────
//   竹内さんの番 680（conductor_turn_vectors・最初の一手）で、判断のブレインの外れが寄っていた理由だけを深く読む:
//     申込・審査の言葉 41〜42%・複数の依頼 34.5%（普通 24.5%・短いお礼 12.3%・約束の結果待ち 25%・久しぶり 27%＝寄っていない）。
//     外れの向きは「AIX と読み・竹内さんは返信」が 52/65（brain_weaknesses meeting-gap:brain-apply-multi-ask-over-aix）。
//   形: 最初の判断の後に1回だけ、読み直しの口（brain-recheck の from=deep・kind=reread）で、依頼を1つずつ分けて決め直させる（決めるのはブレイン・答えは差し替えない）。
//   切替: BRAIN_DEEP_RECHECK（既定 off・=on で読み直す）。10/22 の「速く・じっくり」を全部の番に一律にした形（効かなかった）は繰り返さない。
export const DEEP_RECHECK_REASONS = ["複数の依頼", "申込", "審査"] as const;
export const deepRecheckOn = (env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_DEEP_RECHECK ?? "").trim().toLowerCase() === "on";

/** 深く読む材料の1行（理由ごと）。竹内さんの P0（スタッフだけが知る事は AIX・返信は AI が知り得る事だけ）と 9/30 の決定（審査・入居までの流れ・必要書類の質問は返信）に沿う */
export function deepRecheckMaterial(reason: string): string {
  const split = "お客様の今の連投の依頼を1つずつ書き出し、それぞれ『会話・送った資料・会社の事実で今答えられる依頼』か『スタッフだけが知る事（管理会社の確認の結果・募集状況・見積の金額・内覧の日程の確定）が要る依頼』かを分けてから、道を決め直す。";
  const p0 = "全部を今答えられるなら返信。スタッフだけが知る事が要る依頼が残る時だけ、その依頼を AIX か確かめる約束にする（答えられる依頼は返信の中で答える）。";
  if (reason === "申込" || reason === "審査") return `${split}申込・審査の話のうち、流れ・必要書類・審査の目安・入居までの期間は会社の事実で答えられる（返信）。物件ごとの申込の枠・審査の結果などスタッフだけが知る事だけを AIX にする。${p0}`;
  return `${split}${p0}`;
}

/** 深く読む番なら読み直しの材料を返す（深く読む理由が DEEP_RECHECK_REASONS の時だけ・それ以外は null＝普通の番は今まで通り） */
/**
 * 2026-11-05 P0 575a7cd5（統括は重点を先に決め、必要なブレインだけを動かし、返ってきた答えを確かめて1つにまとめる）:
 *   この読み直しは統括の後半（確かめて決め直す）。前半の「重点」（作業員5・meta.conductor_focus）がある時は、重点に沿って決め直すよう材料の先頭に書く。
 *   重点が無い時は今まで通り（材料は変えない）。
 */
export type ConductorFocusLite = { focus: string; why?: string | null } | null | undefined;
export function deepRecheckFor(dep: { depth: BrainDepth; reason: string } | null | undefined, firstAix: string | null, focus?: ConductorFocusLite): { from: "deep"; kind: "reread"; why: string; firstAix: string | null; material: string } | null {
  if (!dep || dep.depth !== "deep" || !(DEEP_RECHECK_REASONS as readonly string[]).includes(dep.reason)) return null;
  const f = focus && String(focus.focus ?? "").trim() ? `統括の重点「${String(focus.focus).trim().slice(0, 40)}」${focus.why ? `（${String(focus.why).trim().slice(0, 60)}）` : ""}に沿って決め直す。` : "";
  return { from: "deep", kind: "reread", why: `複雑な番（${dep.reason}）`, firstAix, material: `${f}${deepRecheckMaterial(dep.reason)}` };
}

/** digest.dr: "理由:最初→最後"（AIX の鍵・返信は r） */
export const deepRecheckDigest = (reason: string, first: string | null, last: string | null) => `${reason}:${first ?? "r"}→${last ?? "r"}`.slice(0, 60);
