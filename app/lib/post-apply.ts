// app/lib/post-apply.ts
// 「申込以降の会話か」を1か所で決める（別クラウドに回さない・マスク以前に送らない、の判定）。
//
// 2026-09-23 竹内「AIXの申込へボタンがトリガーにする。そうするとお客さんの個人情報（本人確認書類もここで届く）が渡らないのでより安全」
// 2026-09-23 竹内「一度申込にした人でも審査が否決となって再度物件提案中にもどる場合もあるから、その場合は渡してよい。
//   そうしたらまた申込までうごくかたちやから。ただ申込からの審査中は…重要な個人情報が入るかたちとなるからそこは deepseek にわたらないようにする」
//
// 【実物】これまでの判定は conversations.status だけ（llm-alt-provider.isPostApplyStatus）。
//   status は27.4%の会話でブレインの段階より遅れていて（申込昇格の画像の旗が0件）、
//   llm_usage_logs で数えると DeepSeek での返信生成 157回のうち **37回（6会話）が AIX【申込へ】押下・本人確認書類の後**、
//   AIX 物件オススメ（画像経路・歯止めが無かった）171回のうち 114回（5会話）が申込へ押下の後だった（scripts/audit-post-apply-gate.ts）。
//
// 【線】申込以降とみなす根拠（どれも決定論・記録から引ける）:
//   ① status が DRAFT_SKIP_STATUSES（従来。申込・審査中は必ずここ）
//   ② スタッフが付けた申込以降の印（conversations.is_post_apply）
//   ③ AIX【申込へ】（application_push）の最後の押下（aix_usage_logs）
//   ④ お客様からの本人確認書類・収入証明書の最後の受信（messages.image_type = 'id_document' | 'income_document'）
//      2026-09-26 竹内「（収入証明書が届いたら申込中と）みなす」: 収入・勤め先・身元の証明書類も申込の手続きで届く物なので同じ扱い
//      （申込中は DeepSeek に渡さない。personal-document-guard.ts が income_document を付ける）
//   ③④は押した・届いた瞬間に記録されるので、status の昇格を待たない。
//
// 【戻り】③④は**永続にしない**。否決などでスタッフが段階を戻した時刻（conversations.status_manual_back_at・
//   page.tsx の状態変更と「申込以降」の解除で付く）が ③④の最後より**後**なら、申込前に戻ったとみなして再び回してよい。
//   実物: 戻しの印がある9会話のうち8会話が申込へ押下の後の戻し（否決→物件提案中）。
//   その後また申込へを押せば ③ が戻しより新しくなるので、また申込以降になる。
//
// 【使う場所】(1) 別クラウド（DeepSeek）に回さない判定  (2) **下書きを作らない**判定（自動・手動・cron）
//   2026-09-23 竹内「申込中は別のツールで文生成しているので、ここ文生成しなくて大丈夫なところとなる」
//   （9/20「ステータス申込以降は別の管理ツールで LINE しているので返信生成しなくて良い」を、status の遅れに強い形にした物）。
//   ⚠ 下書きを止める側は「記録が読めた時だけ」止める（読めない時に止めると DB の一時障害で下書きが黙って消える）。
//     外に出さない側は読めなければ止める（fail-closed）。向きが違うので呼び出し側で分ける。
//
// 【読めない時】fail-closed（申込以降＝外に出さない側へ倒す）。呼び出し側は loadPostApplyFacts の失敗を true 扱いにする。
//
// 【時刻の線】2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、申込落ちてステータスを切り替えたら、切り替えたところ以降渡せば個人情報防げる」
//   『この会話を今回すか』の二値だと、否決で戻した後に履歴・要約・セーブデータに残った申込中の中身ごと外に出る
//   （実測: 戻した後の DeepSeek 呼び出し 11回・5会話で直近25件に申込中のメッセージが延べ最大64件）。
//   → deepseekSafeCutoff が「どの時刻より後なら渡してよいか」を返し、DeepSeek に送る全経路がこの時刻で切る。
//   線の時刻は conversations.deepseek_cutoff_at（消えない列）。申込以降→申込前に移った時だけ DB のトリガー
//   （stamp_deepseek_cutoff・migrate-schema/route.ts）が書き、前に進めても消さない。次に戻した時だけ新しくなる。
//   旧の線 status_manual_back_at は前に進めると null に戻る（page.tsx の状態変更）ので線には使えなかった（20会話で消えていた）。

import { DRAFT_SKIP_STATUSES } from "./conversation-status";
import { examplePiiReason } from "./example-pii-guard";
import { altPiiSignal, altReapplyGateEnabled } from "./alt-pii-gate";
import { resolveParallelSecond, staffParallelChoiceOf, staffParallelChoiceAt, parallelSecondEnabled, parallelSecondDeepseekEnabled, PARALLEL_STATUSES, PARALLEL_WINDOW_BEFORE_MS, PARALLEL_LOOKBACK_MS, type ParallelState } from "./parallel-second";

export type PostApplyFacts = {
  status: string | null | undefined;
  /** スタッフが付けた申込以降の印（conversations.is_post_apply） */
  isPostApply?: boolean | null;
  /** AIX【申込へ】を最後に押した時刻（ISO）。無ければ null */
  applicationPushAt?: string | null;
  /** お客様から本人確認書類が最後に届いた時刻（ISO）。無ければ null */
  idDocumentAt?: string | null;
  /** スタッフが段階を前に戻した時刻（conversations.status_manual_back_at）。無ければ null。⚠ 前に進めると null に戻る */
  statusManualBackAt?: string | null;
  /** 申込以降→申込前に切り替えた時刻（conversations.deepseek_cutoff_at・消えない列）。無ければ null */
  deepseekCutoffAt?: string | null;
  /**
   * お客様から記入済みの申込フォームが最後に届いた時刻（ISO）。無ければ null。2026-10-18 弱い所A-3③
   *   **DeepSeek の線（deepseekSafeCutoff）だけ**の起点。resolvePostApply（下書きを止める判定）には入れない＝フォームが届いても下書きは今まで通り。
   */
  applicationFormAt?: string | null;
  /** フォームの記録が読めなかった（DeepSeek の線は渡さない側へ倒す・下書きの判定には効かない） */
  applicationFormUnreadable?: boolean;
  /**
   * 2026-10-21 竹内さんの決定（ec4d5990）: 2番手で申込中（並行で探す）と明示的に決まった会話（parallel-second.ts）。
   *   loadPostApplyFacts が「今も申込中」の時だけ読む（読めなければ false＝今まで通り止める・Claude）
   */
  parallel2nd?: boolean;
  /** 2番手で申込中になった時刻（スタッフの文・ピッカー・スタッフの選択。ISO・無ければ null）。DeepSeek の線に使う */
  parallel2ndAt?: string | null;
};

/**
 * 記入済みの申込フォームか（お客様の発言1通）。2026-10-18 弱い所A-3③（設計知見 804934e7: 申込の線は『申込へ押下』だけでは足りない）
 *   10/16 の調べ: 「申込へ」を押す前に届いた記入済みフォームが DeepSeek に出得た（時刻の線が引かれない）。
 *   判定は例文の網（examplePiiReason）と出口の門（altPiiSignal）の「記入済みの申込フォーム」のどちらか＝空の記入欄（値が無い）は当てない。
 */
export function isFilledApplicationForm(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  return examplePiiReason(t)?.reason === "記入済みの申込フォーム" || altPiiSignal(t) === "記入済みの申込フォーム";
}
/** DB で先に絞る語（フォームは必ずどれかを含む・本番の直近 8000通で取りこぼし 0 を確かめた 10/18） */
export const APPLICATION_FORM_PREFILTER = "text.ilike.%記入欄%,text.ilike.%生年月日%,text.ilike.%申込%,text.ilike.%緊急連絡先%,text.ilike.%連帯保証人%,text.ilike.%勤務先%";
/** 戻す: DEEPSEEK_CUTOFF_APPLICATION_FORM=off */
export function applicationFormLineEnabled(): boolean {
  return typeof process === "undefined" || (process.env?.DEEPSEEK_CUTOFF_APPLICATION_FORM ?? "").toLowerCase() !== "off";
}

export type PostApplyReason = "status" | "badge" | "application_push" | "id_document" | null;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/** 申込以降の会話か（純関数）。理由も返す（ログ・監査用）。movedBack は「申込の記録はあるが、その後に戻した」 */
export function resolvePostApply(f: PostApplyFacts): { postApply: boolean; reason: PostApplyReason; movedBack: boolean } {
  if (DRAFT_SKIP_STATUSES.has((f.status ?? "").trim())) return { postApply: true, reason: "status", movedBack: false };
  if (f.isPostApply === true) return { postApply: true, reason: "badge", movedBack: false };
  const pushAt = ms(f.applicationPushAt), docAt = ms(f.idDocumentAt);
  // 戻した時刻は2つの列の新しい方（切り替えた時刻は消えない列、戻しの印は前進で消える）
  const backs = [ms(f.statusManualBackAt), ms(f.deepseekCutoffAt)].filter((x): x is number => x !== null);
  const backAt = backs.length ? Math.max(...backs) : null;
  const latest = Math.max(pushAt ?? -Infinity, docAt ?? -Infinity);
  if (!Number.isFinite(latest)) return { postApply: false, reason: null, movedBack: false };
  // 最後の申込の記録より後に戻していれば申込前（否決→物件提案中）。同時刻は「戻した」側に倒さない（記録が先）
  if (backAt !== null && backAt > latest) return { postApply: false, reason: null, movedBack: true };
  return { postApply: true, reason: latest === pushAt ? "application_push" : "id_document", movedBack: false };
}

/**
 * 2026-10-21 本番の外れ（まりあ・b50fd451）: 9/25 に本人確認書類→ 10/09 にスタッフが物件提案中へ戻したが、スタッフの印（is_post_apply）が
 *   残ったまま＝下書きが黙って作られず「AI文案を作成」を押しても何も出なかった（同じ形の会話 4件）。
 *   印だけが申込以降の理由で、最後の申込の記録（押下・書類）より後に戻している時は、下書きは作る（竹内さん承認「申込から戻ったら Claude だけで下書き」）。
 *   個人情報の線（postApply・Claude 固定・DeepSeek に渡さない）はそのまま＝下書きを止めるかだけをここで分ける。
 *   止める DRAFT_BADGE_MOVEDBACK=off（旧＝印があれば止める）
 */
export function badgeOnlyMovedBack(f: PostApplyFacts, env: Record<string, string | undefined> = process.env): boolean {
  if ((env.DRAFT_BADGE_MOVEDBACK ?? "").trim().toLowerCase() === "off") return false;
  return badgeMovedBackCore(f);
}
/** 印だけが申込以降の理由で、最後の申込の記録（押下・書類）より後に戻している（スイッチを見ない純関数） */
export function badgeMovedBackCore(f: PostApplyFacts): boolean {
  if (f.isPostApply !== true || DRAFT_SKIP_STATUSES.has((f.status ?? "").trim())) return false;
  const backs = [ms(f.statusManualBackAt), ms(f.deepseekCutoffAt)].filter((x): x is number => x !== null);
  if (!backs.length) return false;
  const backAt = Math.max(...backs);
  const latest = Math.max(ms(f.applicationPushAt) ?? -Infinity, ms(f.idDocumentAt) ?? -Infinity);
  return backAt > latest;
}

/** 下書きを止めるか（個人情報の線とは別）: 申込以降でも、印だけ残って戻した会話は止めない（Claude で作る） */
export function postApplyDraftSkip(f: PostApplyFacts, env: Record<string, string | undefined> = process.env): boolean {
  return resolvePostApply(f).postApply && !badgeOnlyMovedBack(f, env) && !parallelSecondActive(f, env);
}

// ═══ 2番手で申込中（並行で探す）（2026-10-21 竹内さんの決定 ec4d5990）═══════════════════════════════
/**
 * 並行の判定に入ってよい会話か（今も申込中・申込以降の先＝契約・成約ではない・印だけ残って戻した会話＝申込歴ありではない）。
 *   ここに入らない会話は parallel2nd を読まない（止め方は今まで通り）
 */
export function parallelEligible(f: PostApplyFacts): boolean {
  const s = (f.status ?? "").trim();
  if (DRAFT_SKIP_STATUSES.has(s) && !PARALLEL_STATUSES.has(s)) return false;
  if (!resolvePostApply(f).postApply) return false;
  return !badgeMovedBackCore(f);
}
/** 2番手で並行して探している会話として扱うか（下書き・ブレインを止めない側）。明示的に決まった会話だけ・スイッチ REAPPLY_PARALLEL_2ND */
export function parallelSecondActive(f: PostApplyFacts, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return f.parallel2nd === true && parallelSecondEnabled(env) && parallelEligible(f);
}
/**
 * 2番手で並行の会話を DeepSeek に回すか（線より後を出口で伏せてから）。既定 off（REAPPLY_PARALLEL_DEEPSEEK=on の時だけ）。
 *   出口の網（LLM_ALT_PII_GATE・LLM_ALT_REAPPLY_GATE）が止まっている時も渡さない（伏せる仕組みが動かない＝Claude のまま）。
 */
export function parallelSecondDeepseek(f: PostApplyFacts, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return parallelSecondActive(f, env) && parallelSecondDeepseekEnabled(env) && altReapplyGateEnabled(env);
}

/**
 * 2番手で申込中（並行で探す）の会話の DeepSeek の線（申込の期間は丸ごと渡さない）。
 *   2026-10-21 確かめ役: 線なし（全部）＋出口で伏せる形は、実データ（申込中・申込歴ありの会話78件の全履歴＋要約＋メモ）で伏せた後にも
 *   お客様の現住所（丁目・番地・部屋番号）・生年月日（「・1990.12.19」「・昭和40年7/23」）・ファイル名の氏名（「_姓_名_給与明細」）・在籍証明の勤め先の法人名が残った。
 *   → 申込歴ありと同じ時刻の線にする: 線＝申込の記録（申込へ押下・本人確認／収入の書類・記入済みフォーム）・2番手になった時刻・切り替え・戻しの遅い方。
 *   線より後だけを渡し（出口は cut として伏せてから値の網・線より前のお客様の発言の網）、線より前（申込フォーム・書類の読み取り・保証人の話）は DeepSeek に出さない。
 *   時刻が1つも無い・読めない時は null（Claude のまま）。
 */
export function parallelSecondCutoff(f: PostApplyFacts): DeepseekCutoff {
  const vals = [f.applicationPushAt, f.idDocumentAt, f.applicationFormAt, f.parallel2ndAt, f.deepseekCutoffAt, f.statusManualBackAt];
  for (const v of vals) if (v && ms(v) === null) return null;
  if (f.applicationFormUnreadable) return null;
  const ts = vals.map((v) => ms(v ?? null)).filter((x): x is number => x !== null);
  if (!ts.length) return null;
  return new Date(Math.max(...ts)).toISOString();
}

/**
 * 返信生成・AIX の入口（出口の網を通る道）で DeepSeek をどう扱うかを1か所で決める。
 *   2番手で並行の会話: 申込以降に数えない・線は parallelSecondCutoff（申込の期間は渡さない）・線より後は出口で伏せてから渡す（印 cut）
 *   それ以外: 今まで通り（deepseekPostApply・deepseekSafeCutoff の reapply）
 *   masked（線なし・全部を伏せる）はどの入口も作らない（実データで伏せ漏れ・上の parallelSecondCutoff）。出口の印 masked の扱いは残す
 */
export function resolveDeepseekEntrance(f: PostApplyFacts, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): { altPostApply: boolean; cutoff: DeepseekCutoff; masked: boolean } {
  if (parallelSecondDeepseek(f, env)) return { altPostApply: false, cutoff: parallelSecondCutoff(f), masked: false };
  return { altPostApply: deepseekPostApply(f, env), cutoff: deepseekSafeCutoff(f, { reapply: true }), masked: false };
}
/** 印を決める（入口の共通・blocked の判定は呼び出し側）: masked の会話は masked、それ以外は cutoffMarkOf */
export function entranceMarkOf(cutoff: DeepseekCutoff | undefined, masked: boolean): CutoffMark {
  return masked && cutoffMs(cutoff) === NO_CUTOFF ? { kind: "masked" } : cutoffMarkOf(cutoff);
}

export function isPostApplyConversation(f: PostApplyFacts): boolean {
  return resolvePostApply(f).postApply;
}

/**
 * 2026-10-21 竹内さんの決定（023ec7bd）「一度申込になってもう一度戻ってきたお客さん…申込中のマスキングちゃんとおこなえば DeepSeek にわたして生成しても良い」:
 *   印（is_post_apply）だけ残って戻した会話にも時刻の線を当てる＝戻した時刻より後だけ DeepSeek に渡す。
 *   申込中の期間（最初の申込の記録〜戻した時刻）は線より前なので渡らない。戻した後に申込フォーム・書類・押下があればまた申込中（線は引けない）。
 *   出口では線のある呼び出し（cut）に申込情報の値の網を強めて当てる（alt-pii-gate.altPiiSignalReapply）。審査の事情は SCREENING_PII_CLAUDE のまま Claude。
 *   止める REAPPLY_DEEPSEEK=off（旧＝印が残っていれば Claude 固定）
 */
export function reapplyDeepseekEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REAPPLY_DEEPSEEK ?? "").trim().toLowerCase() !== "off";
}
/**
 * 印だけ残って戻した会話を DeepSeek の線で扱ってよいか。下書きの判定（badgeMovedBackCore）より狭くする:
 *   印の時刻は残らないので、印を付けた後の「戻す操作」を戻しの印（status_manual_back_at）で確かめる
 *   （画面で印を付けると status_manual_back_at は消え status は申込へ進む＝その後に段階を戻した時だけ新しく付く）。
 *   消えない列（deepseek_cutoff_at）だけでは印を付ける前の古い戻しの可能性があるので使わない。
 */
export function badgeMovedBackForDeepseek(f: PostApplyFacts, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  if (!reapplyDeepseekEnabled(env) || !badgeMovedBackCore(f)) return false;
  const back = ms(f.statusManualBackAt);
  if (back === null) return false;
  const latest = Math.max(ms(f.applicationPushAt) ?? -Infinity, ms(f.idDocumentAt) ?? -Infinity);
  return back > latest;
}
/** DeepSeek に渡さない側の「申込以降」（下書きを止める判定とは別）: 印だけ残って戻した会話は申込以降に数えない（線で切る） */
export function deepseekPostApply(f: PostApplyFacts, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  if (!resolvePostApply(f).postApply) return false;
  return !badgeMovedBackForDeepseek(f, env);
}

// supabase-js の型をそのまま受けると TS2589（型の展開が深すぎる）になるので、使う形だけを緩く受ける
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (table: string) => any };
type Res = { data: unknown; error: { message: string } | null };

/**
 * 記録から根拠を引く。**どれか1つでも読めなければ例外**（呼び出し側は申込以降＝外に出さない側へ倒す）。
 * 3クエリだが全部 index のある列（conversation_id）で軽い。
 */
export async function loadPostApplyFacts(sb: Sb, conversationId: string): Promise<PostApplyFacts> {
  const formOn = applicationFormLineEnabled();
  const [conv, push, idDoc, form] = (await Promise.all([
    sb.from("conversations").select("status, is_post_apply, status_manual_back_at, deepseek_cutoff_at").eq("id", conversationId).maybeSingle(),
    sb.from("aix_usage_logs").select("created_at").eq("conversation_id", conversationId).eq("aix_type", "application_push").order("created_at", { ascending: false }).limit(1),
    sb.from("messages").select("created_at").eq("conversation_id", conversationId).eq("sender", "customer").in("image_type", ["id_document", "income_document"]).order("created_at", { ascending: false }).limit(1),
    // 記入済みの申込フォーム（DeepSeek の線だけの起点）: 語で絞った新しい方から20通を読んで判定。読めなくても例外にしない（下書きの判定を止めない）
    (async (): Promise<Res> => {
      if (!formOn) return { data: [], error: null };
      try {
        return (await sb.from("messages").select("created_at, text").eq("conversation_id", conversationId).eq("sender", "customer")
          .or(APPLICATION_FORM_PREFILTER).order("created_at", { ascending: false }).limit(20)) as Res;
      } catch (e) { return { data: null, error: { message: e instanceof Error ? e.message : String(e) } }; }
    })(),
  ])) as [Res, Res, Res, Res];
  if (conv.error) throw new Error(`post-apply: conversations: ${conv.error.message}`);
  if (push.error) throw new Error(`post-apply: aix_usage_logs: ${push.error.message}`);
  if (idDoc.error) throw new Error(`post-apply: messages: ${idDoc.error.message}`);
  const row = (conv.data ?? null) as { status?: string | null; is_post_apply?: boolean | null; status_manual_back_at?: string | null; deepseek_cutoff_at?: string | null } | null;
  const first = (r: Res): string | null => (((r.data ?? []) as Array<{ created_at?: string | null }>)[0]?.created_at ?? null);
  const facts: PostApplyFacts = {
    status: row?.status ?? null,
    isPostApply: row?.is_post_apply === true,
    applicationPushAt: first(push),
    idDocumentAt: first(idDoc),
    statusManualBackAt: row?.status_manual_back_at ?? null,
    deepseekCutoffAt: row?.deepseek_cutoff_at ?? null,
    applicationFormAt: form.error ? null : (((form.data ?? []) as Array<{ created_at?: string | null; text?: string | null }>).find((m) => isFilledApplicationForm(m.text))?.created_at ?? null),
    applicationFormUnreadable: !!form.error,
  };
  // 2026-10-21（ec4d5990）今も申込中の会話だけ「2番手で並行して探しているか」を読む（申込前・契約以降は読まない＝余計なクエリなし）。読めなければ false（今まで通り）
  if (parallelSecondEnabled() && parallelEligible(facts)) {
    const st = await loadParallelSecondState(sb, conversationId, facts).catch(() => null);
    if (st?.parallel === true) { facts.parallel2nd = true; facts.parallel2ndAt = st.at; }
  }
  return facts;
}

/**
 * 2番手で申込中（並行で探す）の状態を記録から読む（スタッフの選択 → スタッフの文 → ピッカー）。読めなければ例外。
 *   メモの行（customer_memos）・「番手」を含む通（新しい方から60通）・申込状況のピッカー（20件）
 */
export async function loadParallelSecondState(sb: Sb, conversationId: string, f: PostApplyFacts, nowMs: number = Date.now()): Promise<ParallelState> {
  const recs = [ms(f.applicationPushAt), ms(f.idDocumentAt), ms(f.applicationFormAt)].filter((x): x is number => x !== null);
  const last = recs.length ? Math.max(...recs) : null;
  const backs = [ms(f.statusManualBackAt), ms(f.deepseekCutoffAt)].filter((x): x is number => x !== null);
  const back = backs.length ? Math.max(...backs) : null;
  const fromMs = Math.max(last !== null ? last - PARALLEL_WINDOW_BEFORE_MS : nowMs - PARALLEL_LOOKBACK_MS, back ?? -Infinity);
  const fromIso = new Date(fromMs).toISOString();
  const [memo, msgs, pk] = (await Promise.all([
    sb.from("customer_memos").select("items").eq("conversation_id", conversationId).maybeSingle(),
    sb.from("messages").select("sender, text, created_at").eq("conversation_id", conversationId).gte("created_at", fromIso)
      .or("text.ilike.%番手%,text.ilike.%繰り上%,text.ilike.%審査%,text.ilike.%決まって%,text.ilike.%埋まって%,text.ilike.%成約%")
      .order("created_at", { ascending: false }).limit(60),
    sb.from("aix_usage_logs").select("check_pattern, picker_choices, created_at").eq("conversation_id", conversationId).eq("aix_type", "property_check_result")
      .gte("created_at", fromIso).order("created_at", { ascending: false }).limit(20),
  ])) as [{ data: { items?: unknown } | null; error: { message: string } | null }, Res, Res];
  if (memo.error) throw new Error(`parallel-2nd: customer_memos: ${memo.error.message}`);
  if (msgs.error) throw new Error(`parallel-2nd: messages: ${msgs.error.message}`);
  const items = Array.isArray(memo.data?.items) ? (memo.data!.items as Array<{ id?: string; text?: string; retiredAt?: string | null; updatedAt?: string | null; sourceAt?: string | null }>) : [];
  return resolveParallelSecond({
    msgs: ((msgs.data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).map((r) => ({ sender: r.sender, text: r.text, createdAt: r.created_at })),
    pickers: pk.error ? [] : ((pk.data ?? []) as Array<{ check_pattern: string | null; picker_choices: unknown; created_at: string }>).map((r) => ({ checkPattern: r.check_pattern, choices: r.picker_choices, createdAt: r.created_at })),
    lastApplyAt: last === null ? null : new Date(last).toISOString(),
    lastBackAt: back === null ? null : new Date(back).toISOString(),
    staffChoice: staffParallelChoiceOf(items),
    staffAt: staffParallelChoiceAt(items),
    nowMs,
  });
}
// ═══ 時刻の線（DeepSeek に渡してよいのはこの時刻より後だけ）═══════════════════════════════════════

/** 申込の記録が無い＝全部渡してよい */
export const NO_CUTOFF = Number.NEGATIVE_INFINITY;
/** null＝申込中（渡さない）／ISO＝この時刻より後だけ渡す／NO_CUTOFF（-Infinity）＝申込の記録が無いので全部渡してよい */
export type DeepseekCutoff = string | null | number;

/**
 * DeepSeek に渡してよい線（純関数）。
 *   null      … 申込中（resolvePostApply が申込以降）・時刻が読めない（fail-closed）
 *   ISO       … 申込の記録（申込へ押下・証明書類・申込以降の status）の後に切り替えた。この時刻より**後**だけ渡す
 *   -Infinity … 申込の記録も切り替えも無い。全部渡してよい
 * 切り替えの時刻は deepseek_cutoff_at を正にし、無い時だけ status_manual_back_at（旧の線・前進で消える）を使う。
 */
export function deepseekSafeCutoff(f: PostApplyFacts, opts: { reapply?: boolean } = {}): DeepseekCutoff {
  try {
    // 2026-10-21 確かめ役: 印だけ残って戻した会話の線は、出口の強めの網（alt-pii-gate.altPiiSignalReapply）を通る入口（返信生成・AIX）だけが
    //   opts.reapply で開く。それ以外（loadDeepseekCutoff を読むメモの読み取り・好みの学習・画像の読み取り等＝DeepSeek を直接呼び出口の網を通らない道がある）は今まで通り渡さない
    if (opts.reapply ? deepseekPostApply(f) : resolvePostApply(f).postApply) return null;
    // 書いてあるのに読めない時刻がある＝判定が読めない → 渡さない
    for (const v of [f.applicationPushAt, f.idDocumentAt, f.statusManualBackAt, f.deepseekCutoffAt, f.applicationFormAt]) if (v && ms(v) === null) return null;
    // 2026-10-18 弱い所A-3③: 記入済みの申込フォームも申込の記録と同じに数える（フォームの後に戻していなければ渡さない・戻した後は戻した時刻より後だけ）
    const formOn = applicationFormLineEnabled();
    if (formOn && f.applicationFormUnreadable) return null;
    const pushAt = ms(f.applicationPushAt), docAt = ms(f.idDocumentAt), formAt = formOn ? ms(f.applicationFormAt) : null;
    const latest = Math.max(pushAt ?? -Infinity, docAt ?? -Infinity, formAt ?? -Infinity);
    const cut = ms(f.deepseekCutoffAt), back = ms(f.statusManualBackAt);
    // 2026-10-21 印だけ残って戻した会話（023ec7bd）: 印の時刻は分からないので、記録が無くても全部（NO_CUTOFF）にはしない＝戻しの印（印の後の戻す操作）より後だけ。
    //   戻しの後にフォームが届いていればまた申込中（渡さない）。線は戻しの印と切り替えた時刻の遅い方（遅い方が狭い＝安全側）
    if (f.isPostApply === true) {
      if (back === null || !(back > latest)) return null;
      return new Date(Math.max(back, cut ?? -Infinity)).toISOString();
    }
    if (!Number.isFinite(latest)) {
      // 申込へ押下・書類の記録は無いが、status が申込以降だった所から戻した（審査管理の同期で申込・審査中になっていた等）
      return cut !== null ? new Date(cut).toISOString() : NO_CUTOFF;
    }
    // 記録があって申込前＝記録より後に戻している。線は切り替えた時刻（無ければ戻しの印）
    const line = cut !== null && cut > latest ? cut : back !== null && back > latest ? back : null;
    return line === null ? null : new Date(line).toISOString();
  } catch {
    return null;
  }
}

/** 線の時刻（ms）。null＝渡さない／-Infinity＝全部 */
export function cutoffMs(c: DeepseekCutoff | undefined): number | null {
  if (c === null || c === undefined) return null;
  if (typeof c === "number") return c === NO_CUTOFF ? NO_CUTOFF : null;
  return ms(c);
}

/** 線より後の時刻か。線が null なら false。線がある時、時刻が無い・読めない物は false（fail-closed） */
export function isAfterCutoff(ts: string | null | undefined, c: DeepseekCutoff | undefined): boolean {
  const line = cutoffMs(c);
  if (line === null) return false;
  if (line === NO_CUTOFF) return true;
  const t = ms(ts);
  return t !== null && t > line;
}

/** 線より後の物だけ残す（時刻の無い物は落とす＝fail-closed） */
export function filterAfterCutoff<T>(items: ReadonlyArray<T>, tsOf: (x: T) => string | null | undefined, c: DeepseekCutoff | undefined): T[] {
  if (cutoffMs(c) === NO_CUTOFF) return [...items];
  return items.filter((x) => isAfterCutoff(tsOf(x), c));
}

/**
 * fetch の出口（llm-alt-provider）に渡す「切り替えの判定を通った印」。
 *   all … 全部渡してよい／cut … 線より後だけに切った（at は線）／blocked … 渡さない（Claude のまま）
 * 会話の呼び出しで印が無い物は、出口で DeepSeek に回さない（二重の鍵）。
 *   masked … 2026-10-21（ec4d5990）2番手で申込中（並行で探す）: 線は引かないが、出口で申込情報の値を伏せてから渡す（伏せきれなければ Claude）。
 *     出口の網が止まっている時は Claude（llm-alt-provider）。cutoffMarkOf は masked を作らない（入口が entranceMarkOf で明示する時だけ）
 */
export type CutoffMark = { kind: "all" } | { kind: "cut"; at: string } | { kind: "blocked" } | { kind: "masked" };
export function cutoffMarkOf(c: DeepseekCutoff | undefined): CutoffMark {
  const line = cutoffMs(c);
  if (line === null) return { kind: "blocked" };
  if (line === NO_CUTOFF) return { kind: "all" };
  return { kind: "cut", at: new Date(line).toISOString() };
}
export function formatCutoffMark(m: CutoffMark): string {
  return m.kind === "cut" ? `cut:${m.at}` : m.kind;
}
/** ヘッダの値から印を読む。値が無い時は null（印なし）。読めない値は blocked（fail-closed） */
export function parseCutoffMark(v: string | null | undefined): CutoffMark | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (s === "all") return { kind: "all" };
  if (s === "masked") return { kind: "masked" };
  if (s.startsWith("cut:")) { const t = ms(s.slice(4)); return t === null ? { kind: "blocked" } : { kind: "cut", at: new Date(t).toISOString() }; }
  return { kind: "blocked" };
}

/**
 * 出口の網: 線より前のお客様の発言の断片（空白を詰めて minLen 字以上）。
 * 入口で切ったつもりの材料に線より前の文がそのまま残っていないかを出口で見る（入口の取りこぼしの最後の歯止め）。
 * お客様の発言だけにする: スタッフの定型文は他のお客様の手本にも同じ文があり、当たりすぎて DeepSeek が使えなくなる。
 */
const normalizeForNet = (s: string) => s.replace(/\[(?:画像|動画|スタンプ|ファイル)\]/g, "").replace(/[\s\u3000]+/g, "");
export function preCutoffChunks(texts: ReadonlyArray<string | null | undefined>, minLen = 20): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const part of String(t ?? "").split(/[\n。！？!?]+/)) {
      const n = normalizeForNet(part);
      if (n.length >= minLen) out.add(n.slice(0, 60));
    }
  }
  return [...out];
}
/** 送る本文に線より前の断片がいくつ入っているか（0 なら渡してよい） */
export function countCutoffLeaks(body: string, chunks: ReadonlyArray<string>): number {
  if (chunks.length === 0) return 0;
  const b = normalizeForNet(body);
  let n = 0;
  for (const c of chunks) if (b.includes(c)) n++;
  return n;
}

/** 線を記録から引く。読めなければ null（渡さない側）。会話が無い＝申込の記録も無い */
export async function loadDeepseekCutoff(sb: Sb, conversationId: string | null | undefined): Promise<DeepseekCutoff> {
  if (!conversationId) return NO_CUTOFF;
  try { return deepseekSafeCutoff(await loadPostApplyFacts(sb, conversationId)); } catch { return null; }
}

/** 出口の網の材料: 線より前のお客様の発言（新しい方から300通）の断片。読めなければ例外（呼び出し側で渡さない側へ倒す） */
export async function loadPreCutoffCustomerChunks(sb: Sb, conversationId: string, cutoffIso: string): Promise<string[]> {
  const r = (await sb.from("messages").select("text").eq("conversation_id", conversationId).eq("sender", "customer")
    .lte("created_at", cutoffIso).order("created_at", { ascending: false }).limit(300)) as Res;
  if (r.error) throw new Error(`post-apply: pre-cutoff messages: ${r.error.message}`);
  return preCutoffChunks(((r.data ?? []) as Array<{ text?: string | null }>).map((m) => m.text));
}
