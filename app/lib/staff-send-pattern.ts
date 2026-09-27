// app/lib/staff-send-pattern.ts
// 実際のスタッフの送り方（お客様の発言の後、返信だけ／AIX／返信→AIX／AIX→一言／AIX を2つ）を数える型と、
// お客様役のスタッフ側をその型どおりに動かす決め方（純関数・DB も fetch も持たない）。
// 2026-09-27 竹内「AIXにずれがないか確認するためにも実際のスタッフが送ったようになるように／AIXを活用しながらテスト進めていく」
//
// 1か所に置く理由: ①監査 scripts/audit-staff-send-pattern.ts（本番の実送信を数える）と ②お客様役 scripts/customer-sim.ts
//   （スタッフ役が押す AIX・順番・ピッカー・一言を決める）が同じ分類・同じ表を読む（同じ事実を2か所に置かない）。
//
// お客様役のスタッフ役の決まり（decideSimStaffTurn）:
//   ・押す AIX は「画面に出ている AIX」（aix-button-view の resolveAixButtonView → summarizeAixButtonView）。
//     ブレインの判断と画面の表示が違えば「ズレ」として検査に出す（押すのは画面の方＝実際のスタッフが見る物）
//   ・画面に AIX が出ていてもブレインが返信（reply_mode≠aix）の番は、実送信でスタッフが押した率が過半数の時だけ押す
//   ・返信→AIX（返信を先に送ってから同じ番で AIX）は、実送信の割合に合わせて往復の番号で決める（乱数でない・決定論）
//   ・AIX を2つ続けるのは実送信で過半数の組だけ（物件ピックアップした→物件オススメ）
//   ・AIX の後の一言は、画面の送信後のバナー（page.tsx B5 → 同じ種類のテンプレ）と同じテンプレから作る（過半数が添える型だけ）
//   ・ピッカーは pickerForScene（aix-pickers.ts）で場面から選び、log-aix-usage に画面と同じ形で渡す
//
// テスト: app/lib/__tests__/staff-send-pattern.test.ts
import { summarizeAixButtonView, BRAIN_AIX_LABELS, sameAixAction, type AixButtonView } from "@/app/lib/aix-button-view";
import { pickerForScene, AIX_PICKERS, type PickerChoice, type PickerChoices } from "@/app/lib/aix-pickers";
import { AIX_FOLLOWUP_RATE } from "@/app/lib/customer-sim-shadow";
import type { SimAixMaterial } from "@/app/lib/customer-sim-material";

// ─── ①分類（監査・お客様役の共通） ───

/** お客様の連投の後のこちらの1通（時刻順） */
export type StaffSendItem = { t: number; isAix: boolean; aixType: string | null; checkPattern?: string | null; text?: string | null };

/**
 * 1番（お客様の連投 → 次のお客様の発言まで）のこちらの送り方の形。
 *   none … 何も送っていない
 *   reply_only … 手打ち（下書き・テンプレ）だけ
 *   aix_only … AIX だけ（後ろに一言なし）
 *   aix_then_line … AIX の後10分以内に手打ちの一言（テンプレのバナーの一言を含む）
 *   reply_then_aix … 手打ちを先に送ってから同じ番で AIX
 *   aix_aix … 違う種類の AIX を2つ以上（間・後の一言は問わない）
 */
export type StaffTurnShape = "none" | "reply_only" | "aix_only" | "aix_then_line" | "reply_then_aix" | "aix_aix";

export const STAFF_TURN_SHAPE_JA: Record<StaffTurnShape, string> = {
  none: "送らない",
  reply_only: "返信だけ",
  aix_only: "AIX だけ",
  aix_then_line: "AIX→一言",
  reply_then_aix: "返信→AIX",
  aix_aix: "AIX を2つ",
};

export const FOLLOWUP_WINDOW_MS = 10 * 60_000;

export type StaffTurnClass = {
  shape: StaffTurnShape;
  /** 最初に押した AIX（無ければ null） */
  firstAix: string | null;
  firstCheckPattern: string | null;
  /** 押した AIX の種類（時刻順・重複なし） */
  aixTypes: string[];
  /** 最初の AIX より前の手打ち → 最初の AIX までの時間（reply_then_aix の時） */
  replyToAixMs: number | null;
  /** AIX の後10分以内の手打ち（aix_then_line の時・最初の1通） */
  followup: StaffSendItem | null;
};

/** 1番の送り方を分類する（優先: 返信→AIX ＞ AIX を2つ ＞ AIX→一言 ＞ AIX だけ） */
export function classifyStaffTurn(sends: ReadonlyArray<StaffSendItem>, windowMs = FOLLOWUP_WINDOW_MS): StaffTurnClass {
  const s = [...sends].sort((a, b) => a.t - b.t);
  const aix = s.filter((x) => x.isAix);
  const aixTypes: string[] = [];
  for (const a of aix) if (a.aixType && !aixTypes.includes(a.aixType)) aixTypes.push(a.aixType);
  const base = { firstAix: aix[0]?.aixType ?? null, firstCheckPattern: aix[0]?.checkPattern ?? null, aixTypes, replyToAixMs: null as number | null, followup: null as StaffSendItem | null };
  if (s.length === 0) return { shape: "none", ...base };
  if (aix.length === 0) return { shape: "reply_only", ...base };
  const firstAixIdx = s.findIndex((x) => x.isAix);
  const replyBefore = s.slice(0, firstAixIdx).filter((x) => !x.isAix);
  if (replyBefore.length > 0) return { shape: "reply_then_aix", ...base, replyToAixMs: s[firstAixIdx].t - replyBefore[0].t };
  if (aixTypes.length >= 2) return { shape: "aix_aix", ...base };
  const lastAix = aix[aix.length - 1];
  const fu = s.find((x) => !x.isAix && x.t > lastAix.t && x.t - lastAix.t <= windowMs) ?? null;
  if (fu) return { shape: "aix_then_line", ...base, followup: fu };
  return { shape: "aix_only", ...base };
}

/** ブレインの判断の場面（監査の行の見出し）。AIX の判断は AIX の種類ごと・それ以外は「返信」 */
export function brainSceneLabel(b: { suggested_action?: string | null; suggested_reply_mode?: string | null } | null | undefined): string {
  if (!b) return "（判断なし）";
  const a = b.suggested_action ?? null;
  if (b.suggested_reply_mode === "aix" && a) return `AIX:${a}`;
  if (a) return `返信（点滅 ${a}）`;
  return "返信";
}

// ─── ②本番の実送信の数字（scripts/audit-staff-send-pattern.ts・グループと YUMA を除く） ───
//   数字は 2026-09-27 に監査を回して書いた（AIX の記録は 90日の中にしか無いので AIX の数字は 90日＝180日。ブレインの判断の記録は 9/12〜）。
//   変える時は監査を回して頭の数字も直す。
//   形（90日・こちらが送った 2,909番）: 返信だけ 1,792（62%）・AIX だけ 347（12%）・AIX→一言 220（8%）・返信→AIX 381（13%）・AIX を2つ 169（6%）
//     ＝AIX を押した番 1,101（38%）。180日（AIX の前の期間を含む 4,241番）では返信だけ 74%

/**
 * ブレインが AIX を判断した番（reply_mode=aix）で、その AIX を押した番のうち「返信を先に送ってから押した」率。
 *   ブレインの AIX を押した 136番のうち返信を先に送った 21（15%）。返信→AIX の間の中央: ピックアップ 96分・物件確認 25分・見積書 13分・申込 1分
 *   決定論で選ぶ（往復の番号）。表に無い AIX は返信→AIX をしない
 */
export const REPLY_THEN_AIX_RATE: Readonly<Record<string, { rate: number; n: number }>> = {
  property_send: { rate: 0.18, n: 44 },
  property_check_result: { rate: 0.13, n: 30 },
  estimate_sheet: { rate: 0.14, n: 21 },
  application_push: { rate: 0.25, n: 12 },
  meeting_place: { rate: 0.11, n: 9 },
  viewing_invite: { rate: 0, n: 9 },
};

/**
 * 画面に AIX が出ている（帯・点滅）がブレインは返信（action を持つが reply_mode≠aix）の番で、スタッフがその AIX を押した率。
 *   過半数の時だけスタッフ役も押す（表に無い AIX は押さない）。実送信 5番で押したのは 0
 */
export const SHOWN_NOT_AIX_PRESS_RATE: Readonly<Record<string, { rate: number; n: number }>> = {
  property_send: { rate: 0, n: 4 },
  property_check_result: { rate: 0, n: 1 },
};

/**
 * AIX を2つ続ける組（先>後）の率（先の AIX を押した番のうち、同じ番で後の AIX も押した率・90日）。過半数の組だけ置く。
 *   物件ピックアップした>物件オススメ 225/301（75%・送ったお部屋の中から1件を🌟で推す）
 *   入れない: 物件確認した>ピックアップ 14/257（5%）・物件確認した>オススメ 12/257・見積書>申込へ 5/171 等（どれも1割未満）
 */
export const AIX_PAIR_RATE: Readonly<Record<string, { rate: number; n: number }>> = {
  "property_send>property_recommendation": { rate: 0.75, n: 301 },
};

/**
 * AIX の後の一言のテンプレ（画面の送信後のバナー＝ /api/aix/action の suggest_template_category と同じカテゴリ）。
 *   率は AIX_FOLLOWUP_RATE（customer-sim-shadow.ts・過半数の型だけ）。監査で数え直しても 見積書 81%・申込へ 76%・物件オススメ 70%（90日）
 *   ここはカテゴリだけ（テンプレの本文は DB の templates・選ぶのは実送信でバナーから一番選ばれたテンプレ＝template_selection_logs の post_aix）
 *   バナーから選んだ一言は 全部「AI 最適化」（generate-reply の templateText）を通して送られている（post_aix 183件 was_adapted=true）
 *   ＝お客様役も同じ最適化を通す（テンプレの「築年数も新しく…」をそのまま送ったのは 17/153 だけ）
 */
export const FOLLOWUP_TEMPLATE_CATEGORY: Readonly<Record<string, string>> = {
  estimate_sheet: "見積書送る【AIX】",
  application_push: "申込へ！【AIX】",
  property_recommendation: "物件オススメ【AIX】",
};

/**
 * 一言を添えてよい選択か（申込へ の一言「②申込時フォーマット（続き）」は申込フォーマットの後だけ＝申込誘導・確定・書類依頼の後には添えない）
 */
export function followupAllowed(action: string, pickerValue: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (action === "application_push" && pickerValue !== "format") return { ok: false, reason: `申込へ の一言（②申込時フォーマット（続き））は申込フォーマットの後だけ（今は ${pickerValue ?? "選択なし"}）` };
  return { ok: true };
}

/** 実送信の形の割合（90日・こちらが送った 2,909番）。お客様役の要約で並べて比べる */
export const REAL_SHAPE_RATE: Readonly<Record<Exclude<StaffTurnShape, "none">, number>> = {
  reply_only: 0.62, aix_only: 0.12, aix_then_line: 0.08, reply_then_aix: 0.13, aix_aix: 0.06,
};

/** お客様役の1往復の形（送った物から） */
export function simRowShape(r: { sent?: string | null; sentKind?: string | null; replyFirstText?: string | null; secondAixText?: string | null; followupText?: string | null }): StaffTurnShape {
  const aix = String(r.sentKind ?? "").startsWith("AIX ");
  if (!r.sent && !r.replyFirstText) return "none";
  if (!aix) return "reply_only";
  if (r.replyFirstText) return "reply_then_aix";
  if (r.secondAixText) return "aix_aix";
  if (r.followupText) return "aix_then_line";
  return "aix_only";
}

// ─── ③決定論の「割合どおり」 ───

/**
 * 往復の番号 n（1始まり）で、割合 rate に合わせて行うか（乱数でない）。
 *   黄金比の小数部の並び（低食い違い列）: n=1..N で当たる回数は rate×N にほぼ一致し、同じ n・rate・salt なら毎回同じ結果
 */
export function deterministicHit(n: number, rate: number, salt = ""): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  let h = 0;
  for (const ch of salt) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const phi = 0.6180339887498949;
  const x = ((Math.max(0, Math.floor(n)) + (h % 1000) / 1000) * phi) % 1;
  return x < rate;
}

// ─── ④画面の AIX とブレインの判断（押す AIX とズレ） ───

export type SimAixViewMismatch =
  | "brain_aix_not_shown"   // ブレインは AIX（reply_mode=aix）なのに画面に AIX が出ていない
  | "shown_differs"         // 画面の AIX とブレインの AIX が違う
  | "shown_brain_reply"     // ブレインは同じ action を持つが reply_mode≠aix（返信）なのに画面に AIX（帯・点滅）が出ている
  | "shown_without_brain"   // ブレインは AIX なし（action なし・別の action）なのに画面に AIX が出ている
  | "gone_after_reply";     // 返信を先に送ったら画面から AIX が消えた（返信→AIX の番で押す AIX が画面に無い）

export const SIM_AIX_VIEW_MISMATCH_JA: Record<SimAixViewMismatch, string> = {
  brain_aix_not_shown: "画面: ブレインの AIX が出ていない",
  shown_differs: "画面: ブレインと違う AIX",
  shown_brain_reply: "画面: AIX が出ている（ブレインは返信）",
  shown_without_brain: "画面: ブレインは AIX なしなのに出ている",
  gone_after_reply: "画面: 返信を先に送ったら AIX が消えた",
};
export const SIM_AIX_VIEW_MISMATCHES = Object.keys(SIM_AIX_VIEW_MISMATCH_JA) as SimAixViewMismatch[];

export type SimViewMismatch = { kind: SimAixViewMismatch; detail: string };

/** 画面のズレの要約（種類ごとの件数・0件の種類も並べる） */
export function summarizeViewMismatch(rows: ReadonlyArray<{ viewMismatches?: ReadonlyArray<{ kind: SimAixViewMismatch }> | null }>): Array<{ kind: SimAixViewMismatch; label: string; count: number }> {
  return SIM_AIX_VIEW_MISMATCHES.map((k) => ({ kind: k, label: SIM_AIX_VIEW_MISMATCH_JA[k], count: rows.reduce((n, r) => n + (r.viewMismatches ?? []).filter((x) => x.kind === k).length, 0) }));
}

export type SimBrainMetaLike = {
  action?: string | null;
  reply_mode?: string | null;
  check_pattern?: string | null;
  two_choice_mode?: boolean | null;
  alt_actions?: string[] | null;
} | null | undefined;

export type SimAixViewRead = {
  /** 画面が出す AIX（帯・カード・2択・点滅・なし） */
  shown: string | null;
  channel: ReturnType<typeof summarizeAixButtonView>["channel"];
  /** 2択の時の AIX（"two_choice:<action>" を外した物） */
  shownAction: string | null;
  /** 画面の2つ目の AIX（カードの altActions） */
  shownAlt: string[];
  mismatches: SimViewMismatch[];
};

/** 画面の表示（resolveAixButtonView の結果）とブレインの判断を並べる */
export function readAixView(view: AixButtonView, meta: SimBrainMetaLike): SimAixViewRead {
  const sum = summarizeAixButtonView(view);
  const shownAction = sum.shown ? sum.shown.replace(/^two_choice:/, "") : null;
  const brainAix = meta?.reply_mode === "aix" && meta?.action && BRAIN_AIX_LABELS[meta.action] ? meta.action : null;
  const mm: SimViewMismatch[] = [];
  if (brainAix && !shownAction) mm.push({ kind: "brain_aix_not_shown", detail: `ブレイン=${brainAix}・画面=なし` });
  else if (brainAix && shownAction && !sameAixAction(brainAix, shownAction)) mm.push({ kind: "shown_differs", detail: `ブレイン=${brainAix}・画面=${sum.shown}（${sum.channel}）` });
  if (!brainAix && shownAction) {
    if (meta?.action && sameAixAction(meta.action, shownAction)) mm.push({ kind: "shown_brain_reply", detail: `ブレイン=${meta.action}（reply_mode=${meta.reply_mode ?? "-"}）・画面=${sum.shown}（${sum.channel}）` });
    else mm.push({ kind: "shown_without_brain", detail: `ブレイン=${meta?.action ?? "なし"}（reply_mode=${meta?.reply_mode ?? "-"}）・画面=${sum.shown}（${sum.channel}）` });
  }
  return { shown: sum.shown, channel: sum.channel, shownAction, shownAlt: view.card?.altActions ?? [], mismatches: mm };
}

/** 返信を先に送った後の画面に、押す AIX がまだ出ているか（出ていなければ gone_after_reply） */
export function checkAfterReply(pressAix: string, after: SimAixViewRead): SimViewMismatch | null {
  if (after.shownAction && sameAixAction(after.shownAction, pressAix)) return null;
  return { kind: "gone_after_reply", detail: `押す AIX=${pressAix}・返信の後の画面=${after.shown ?? "なし"}（${after.channel}）` };
}

// ─── ⑤スタッフ役の1番の決め方 ───

export type SimStaffTurnPlan = {
  /** 押す AIX（無ければ返信だけ） */
  pressAix: string | null;
  /** 押す AIX の check_pattern（ブレインの判断・無ければ null） */
  checkPattern: string | null;
  /** 返信を先に送ってから AIX を押す */
  replyFirst: boolean;
  /** 最後の AIX の後に一言（テンプレのバナー）を添える */
  followup: boolean;
  /** 2つ目の AIX（実送信でその組が過半数の時だけ） */
  secondAix: string | null;
  /** 決め方の説明（表示用） */
  reasons: string[];
};

export type SimStaffTurnInput = {
  /** 往復の番号（1始まり・決定論の割合に使う） */
  round: number;
  meta: SimBrainMetaLike;
  view: SimAixViewRead;
  /** 表（既定は上の定数。テストで差し替える） */
  replyThenAixRate?: Readonly<Record<string, { rate: number; n: number }>>;
  shownNotAixPressRate?: Readonly<Record<string, { rate: number; n: number }>>;
  followupRate?: Readonly<Record<string, { rate: number; n: number }>>;
  aixPairRate?: Readonly<Record<string, { rate: number; n: number }>>;
};

/** 画面・ブレイン・実送信の割合から、スタッフ役がこの番に何をするか（純関数・決定論） */
export function decideSimStaffTurn(input: SimStaffTurnInput): SimStaffTurnPlan {
  const { round, meta, view } = input;
  const rt = input.replyThenAixRate ?? REPLY_THEN_AIX_RATE;
  const pp = input.shownNotAixPressRate ?? SHOWN_NOT_AIX_PRESS_RATE;
  const fr = input.followupRate ?? AIX_FOLLOWUP_RATE;
  const pr = input.aixPairRate ?? AIX_PAIR_RATE;
  const reasons: string[] = [];
  let press: string | null = null;
  if (view.shownAction) {
    if (meta?.reply_mode !== "aix") {
      // 画面に AIX が出ているがブレインは返信: 実送信で押した率が過半数の時だけ押す
      const r = pp[view.shownAction];
      if (r && r.rate >= 0.5) { press = view.shownAction; reasons.push(`ブレインは返信だが画面に AIX（${view.channel}）・実送信は ${Math.round(r.rate * 100)}%（n=${r.n}）押す`); }
      else reasons.push(`ブレインは返信・画面に AIX（${view.channel}）→ 押さない${r ? `（実送信で押したのは ${Math.round(r.rate * 100)}%・n=${r.n}）` : "（実送信の数字なし）"}`);
    } else {
      press = view.shownAction;
      reasons.push(`画面に出ている AIX（${view.channel}）を押す`);
    }
  } else reasons.push("画面に AIX が出ていない → 返信");
  if (!press) return { pressAix: null, checkPattern: null, replyFirst: false, followup: false, secondAix: null, reasons };
  const checkPattern = meta?.action && sameAixAction(meta.action, press) ? (meta.check_pattern ?? null) : null;
  const rr = rt[press];
  const replyFirst = !!rr && deterministicHit(round, rr.rate, `reply_then_aix:${press}`);
  if (rr) reasons.push(`返信→AIX は実送信 ${Math.round(rr.rate * 100)}%（n=${rr.n}）→ この番は${replyFirst ? "返信を先に送る" : "AIX から"}`);
  // 2つ目の AIX: 実送信で過半数の組だけ（画面のカードの2つ目に出ているかは問わない＝スタッフは続けて押している）
  let secondAix: string | null = null;
  for (const [pair, p] of Object.entries(pr)) {
    const [a, b] = pair.split(">");
    if (a !== press || !(p.rate >= 0.5)) continue;
    secondAix = b;
    reasons.push(`続けて AIX ${b}（実送信 ${Math.round(p.rate * 100)}%・n=${p.n}${view.shownAlt.includes(b) ? "・画面の2つ目にも出ている" : ""}）`);
    break;
  }
  // 一言は最後に押した AIX で決める（ピックアップ→オススメの番は オススメの後の一言）
  const last = secondAix ?? press;
  const fu = fr[last];
  const followup = !!fu && fu.rate >= 0.5;
  if (fu) reasons.push(`${last} の後の一言は実送信 ${Math.round(fu.rate * 100)}%（n=${fu.n}）→ ${followup ? "添える" : "添えない"}`);
  return { pressAix: press, checkPattern, replyFirst, followup, secondAix, reasons };
}

/**
 * 2つ目の AIX の材料（ピックアップ→オススメ: 今送ったピックアップの1件目＝「お送りさせて頂きましたお部屋の中でも特に…」）。
 *   それ以外の組は材料の選び方（pickSimMaterial）に任せる＝null
 */
export function secondAixMaterial(first: SimAixMaterial | null, secondAction: string): SimAixMaterial | null {
  if (secondAction === "property_recommendation" && first?.kind === "pickups" && first.items.length > 0) return { kind: "pickups", items: [first.items[0]] };
  return null;
}

// ─── ⑥ピッカー（場面 → 画面と同じ記録の形） ───

export type SimPickerContext = {
  aixType: string;
  /** お客様の今回の連投 */
  turnText?: string | null;
  hasImage?: boolean;
  /** これまでに送った物件の数 */
  sentPropertyCount?: number;
  /** 直近のこちらの文（古→新）。物件なかった の後か・条件を広げたか・申込書を送った後かを読む */
  recentStaffTexts?: ReadonlyArray<string>;
  /** 物件確認した の材料の募集状況（保存済みの設定） */
  roomStatus?: "available" | "vacating" | "ended" | "other_room" | "exclusive" | "unknown";
  estimateCount?: number;
};

const ENDED_RE = /募集(?:が)?終了|募集(?:を)?停止|募集に出ていない|満室|申込(?:が)?入って(?:しまい|おり)|お部屋(?:が)?埋まって/;
const WIDEN_RE = /(?:条件|エリア|地域|家賃|ご予算|間取り)[^\n。]{0,12}広げ/;
/** お客様が条件を言い直した（間取り・家賃・エリア・駅・人数） */
const COND_RESTATE_RE = /[0-9０-９]\s*(?:S?LDK|DK|K)\b|ワンルーム|[0-9０-９]+(?:\.[0-9]+)?\s*万|家賃|エリア|[区市町]で|駅(?:まで|から|徒歩)|徒歩|以内|以上|ひとり|一人|二人|2人/;
const APPLY_HESITATE_RE = /迷|悩|検討|考え|どうしよう|か(?:な|も)[？?🤔]?$/;
const DOCS_RE = /書類|身分証|免許証|保険証|源泉|給与明細|収入証明|住民票|マイナンバー/;

/**
 * 場面からピッカーを選ぶ（pickerForScene に、会話から読める物を渡す）。実送信（90日）で pickerForScene と外れる所だけ上書きする:
 *   物件ピックアップした（send_mode・実際 new_arrival 150・normal 140・widen 51・alternative 3）:
 *     お客様が条件を言い直した（条件の語2つ以上）・条件を広げた後 → widen（条件広げまとめ）。alternative は実送信でほぼ使わない（3/344）
 *     一致 192/277（69%）→ 207/277（75%）
 *   申込へ（app_sub_mode・実際 format 58・push 6・confirm 4・docs_request 3）:
 *     申込書（記入欄）を送った後 → 書類の話なら docs_request・それ以外は confirm ／ 迷い・検討 → push ／ それ以外 → format
 *     一致 12/72（17%・「この物件で決めます」「審査通して欲しい」を push にしていた）→ 56/72（78%）
 *   物件確認した は pickerForScene のまま（結果は材料の設定で決まる・会話から読むと 189/258＝73%）
 */
export function simPickerFor(ctx: SimPickerContext): PickerChoice | null {
  const staff = (ctx.recentStaffTexts ?? []).slice(-6).join("\n");
  const turn = String(ctx.turnText ?? "").trim();
  const base = pickerForScene({
    aixType: ctx.aixType, turnText: turn, hasImage: ctx.hasImage ?? false, roomStatus: ctx.roomStatus ?? "unknown",
    sentPropertyCount: ctx.sentPropertyCount ?? 0, afterEnded: ENDED_RE.test(staff), widened: WIDEN_RE.test(staff), estimateCount: ctx.estimateCount ?? 1,
  });
  if (!base) return null;
  const mk = (value: string, label: string, reason: string): PickerChoice => ({ field: base.field, value, label, reason });
  if (ctx.aixType === "property_send") {
    const condHits = (turn.match(new RegExp(COND_RESTATE_RE.source, "g")) ?? []).length;
    if ((ctx.sentPropertyCount ?? 0) > 0 && (condHits >= 2 || WIDEN_RE.test(staff))) return mk("widen", "条件広げまとめ", "条件の言い直し（条件の語2つ以上）・条件を広げた後（実送信で widen）");
    if (base.value === "alternative") return mk((ctx.sentPropertyCount ?? 0) > 0 ? "new_arrival" : "normal", (ctx.sentPropertyCount ?? 0) > 0 ? "新着まとめ" : "初回まとめ／新規物件", "代替物件送りは実送信でほぼ使わない（3/344）");
    return base;
  }
  if (ctx.aixType === "application_push") {
    if (/記入欄】/.test(staff)) return DOCS_RE.test(turn) ? mk("docs_request", "書類依頼", "申込書を送った後の書類の話") : mk("confirm", "申込確定", "申込書を送った後（申込の確定）");
    if (APPLY_HESITATE_RE.test(turn)) return mk("push", "申込誘導", "迷い・検討（申込の後押し）");
    return mk("format", "申込フォーマット送る", "申込の意思（実送信の 76% は申込フォーマット）");
  }
  return base;
}

/** log-aix-usage の body に足す欄（画面 page.tsx と同じ形: check_pattern / send_mode / app_sub_mode の列＋picker_choices） */
export function pickerLogFields(aixType: string, choice: PickerChoice | null, base: { checkPattern?: string | null; extraChoices?: PickerChoices | null } = {}): { check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: PickerChoices | null } {
  const out = { check_pattern: base.checkPattern ?? null, send_mode: null as string | null, app_sub_mode: null as string | null, picker_choices: (base.extraChoices && Object.keys(base.extraChoices).length ? { ...base.extraChoices } : null) as PickerChoices | null };
  if (!choice) return out;
  const def = AIX_PICKERS[aixType]?.pickers.find((p) => p.key === choice.field);
  if (def?.column === "check_pattern") out.check_pattern = choice.value;
  else if (def?.column === "send_mode") out.send_mode = choice.value;
  else if (def?.column === "app_sub_mode") out.app_sub_mode = choice.value;
  else out.picker_choices = { ...(out.picker_choices ?? {}), [choice.field]: choice.value };
  return out;
}

/**
 * /api/aix/action の body に足す欄（画面の AixModal が同じピッカーで渡す物だけ）。
 *   物件ピックアップした: send_mode ／ 物件オススメ: 新着1件 → is_new_arrival ／ 申込へ: app_sub_mode（push は app_push_type=simple・vacancy_status=vacant）
 *   screenOnly: 画面が API を呼ばずに固定文を作る選択（申込フォーマット＝AixModal の APP_FORMAT_SECTIONS）
 */
export function pickerAixBody(aixType: string, choice: PickerChoice | null): { body: Record<string, unknown>; screenOnly?: "application_format" } {
  if (!choice) return { body: {} };
  if (aixType === "property_send" && choice.field === "send_mode") return { body: { send_mode: choice.value } };
  if (aixType === "property_recommendation" && choice.field === "pickup_type") return { body: choice.value === "新着1件" ? { is_new_arrival: true } : {} };
  if (aixType === "application_push" && choice.field === "app_sub_mode") {
    if (choice.value === "format") return { body: {}, screenOnly: "application_format" };
    if (choice.value === "push") return { body: { app_sub_mode: "push", app_push_type: "simple", vacancy_status: "vacant" } };
    return { body: { app_sub_mode: choice.value } };
  }
  return { body: {} };
}

// ─── ⑦申込フォーマット（画面の固定文をそのまま使う） ───

export type AppFormatSections = { applicant: string; roommate: string; emergency: string; guarantor: string };

/**
 * AixModal.tsx の本文から APP_FORMAT_SECTIONS（申込フォーマットの固定文）を読む（文を2か所に置かないため、画面の物をそのまま読む）。
 *   読めなければ null（お客様役は申込フォーマットを送らずに理由を出す）
 */
export function parseAppFormatSections(aixModalSource: string | null | undefined): AppFormatSections | null {
  const src = String(aixModalSource ?? "");
  const start = src.indexOf("const APP_FORMAT_SECTIONS = {");
  if (start < 0) return null;
  const end = src.indexOf("\n};", start);
  const block = src.slice(start, end < 0 ? undefined : end);
  const out: Partial<AppFormatSections> = {};
  for (const m of block.matchAll(/(applicant|roommate|emergency|guarantor):\s*`([^`]*)`/g)) out[m[1] as keyof AppFormatSections] = m[2];
  return out.applicant && out.emergency && out.guarantor && out.roommate ? (out as AppFormatSections) : null;
}

/** 画面（AixModal の format）と同じ組み立て: 申込者 → （同居あり）同居人 → 緊急連絡先／連帯保証人 */
export function buildAppFormatText(sec: AppFormatSections, opt: { living: "single" | "shared"; guarantor: "emergency" | "guarantor" }): string {
  const parts = [sec.applicant];
  if (opt.living === "shared") parts.push(sec.roommate);
  parts.push(opt.guarantor === "emergency" ? sec.emergency : sec.guarantor);
  return parts.join("\n\n");
}

// ─── ⑧AIX の後の一言（送信後のバナーのテンプレ） ───

export type FollowupTemplate = { id: string; label: string; text: string; category: string };

/** バナーの一言に使えない物（お待たせ・書き込み欄のフォーム・AI が作る見出し・画像が要る） */
export function followupTemplateUsable(t: { text: string | null | undefined; requires_image?: boolean | null }): boolean {
  const s = String(t.text ?? "");
  if (!s.trim()) return false;
  if (t.requires_image) return false;
  if (/お待たせ/.test(s)) return false;                 // feedback_no_omatase
  if (/記入欄】|フォーマット\s*個人用/.test(s)) return false; // 申込書本体（AIX【申込へ】の format が送る物）
  if (/AIが[^\n]{0,10}生成/.test(s)) return false;
  return true;
}

/**
 * バナーから選ぶテンプレ（実送信で post_aix から選ばれた回数の多い順・同数は sort_order）。使えない物は飛ばす
 */
export function pickFollowupTemplate(
  templates: ReadonlyArray<{ id: string; label: string; text: string | null; category: string; requires_image?: boolean | null; sort_order?: number | null }>,
  postAixPicks: Readonly<Record<string, number>>,
): FollowupTemplate | null {
  const ok = templates.filter((t) => followupTemplateUsable(t));
  ok.sort((a, b) => (postAixPicks[b.id] ?? 0) - (postAixPicks[a.id] ?? 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const t = ok[0];
  return t ? { id: t.id, label: t.label, text: String(t.text), category: t.category } : null;
}

/**
 * テンプレの穴を埋める（画面の TemplateModal と同じ「アカウント名 → お客様名」＋物件名の伏せ字）。AI 最適化が失敗した時の予備。
 *   物件名の伏せ字: 「マンション名〇〇号室」「〇〇マンション〇〇号室」「〇〇マンション」「マンション名」「〇〇」（最初の1つだけ・物件名）
 *   埋まらない伏せ字（〇〇・◯・{{…}}・アカウント名）が残ったら送らない
 */
export function fillFollowupTemplate(text: string, ctx: { customerName: string | null | undefined; propertyLabel: string | null | undefined }): { text: string } | { text: null; reason: string } {
  let s = String(text ?? "");
  const name = String(ctx.customerName ?? "").trim();
  const prop = String(ctx.propertyLabel ?? "").trim();
  if (/アカウント名/.test(s)) {
    if (!name) return { text: null, reason: "お客様名が無い（アカウント名が埋まらない）" };
    s = s.replace(/アカウント名/g, name);
  }
  if (prop) {
    const PROP_RES = [/マンション名\s*[〇○◯]{2}\s*号室/, /[〇○◯]{2}\s*マンション\s*[〇○◯]{2}\s*号室/, /[〇○◯]{2}\s*マンション/, /マンション名/, /[〇○◯]{2}/];
    for (const re of PROP_RES) { if (re.test(s)) { s = s.replace(re, prop); break; } }
  }
  const left = s.match(/[〇○◯]+|\{\{[^}]*\}\}|アカウント名|マンション名/);
  if (left) return { text: null, reason: `埋まらない伏せ字「${left[0]}」が残る` };
  return { text: s };
}

/** 一言の物件名（材料から「物件名 号室」。号室は資料の文字のまま） */
export function followupPropertyLabel(m: SimAixMaterial | null): string | null {
  if (!m) return null;
  if (m.kind === "estimate") return `${m.propertyName}${m.roomNo ? ` ${m.roomNo}` : ""}`.trim();
  if (m.kind === "pickups") { const p = m.items[0]; return p ? `${p.propertyName}${p.roomNo ? ` ${p.roomNo}` : ""}`.trim() : null; }
  if (m.kind === "check_result" || m.kind === "meeting") return m.propertyName;
  if (m.kind === "viewing_slots") return m.propertyName;
  return null;
}

// ─── ⑨送る画像（pickup-send-image の決まり: trim_image_url＝元の資料の1ページ目だけ） ───

/**
 * 送れないピックアップ（trim_image_url が無い＝元の資料のまま描いた画像が無い）の名前。お客様役は送らずに理由を出す
 *   （2026-09-27 の決まり: page_image_url は書体を差し替えた画像・agent_image_url は元付業者の面＝送らない）
 */
export function pickupsWithoutSendImage(rows: ReadonlyArray<{ property_name: string | null; room_no?: string | null; trim_image_url?: string | null; sent_at?: string | null; status?: string | null }>): string[] {
  return rows
    .filter((r) => !r.trim_image_url && !r.sent_at && r.status !== "sent" && r.status !== "excluded")
    .map((r) => `${r.property_name ?? "?"}${r.room_no ? ` ${r.room_no}` : ""}`);
}
