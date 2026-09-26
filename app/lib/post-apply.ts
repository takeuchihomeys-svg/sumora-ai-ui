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
};

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

export function isPostApplyConversation(f: PostApplyFacts): boolean {
  return resolvePostApply(f).postApply;
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
  const [conv, push, idDoc] = (await Promise.all([
    sb.from("conversations").select("status, is_post_apply, status_manual_back_at, deepseek_cutoff_at").eq("id", conversationId).maybeSingle(),
    sb.from("aix_usage_logs").select("created_at").eq("conversation_id", conversationId).eq("aix_type", "application_push").order("created_at", { ascending: false }).limit(1),
    sb.from("messages").select("created_at").eq("conversation_id", conversationId).eq("sender", "customer").in("image_type", ["id_document", "income_document"]).order("created_at", { ascending: false }).limit(1),
  ])) as [Res, Res, Res];
  if (conv.error) throw new Error(`post-apply: conversations: ${conv.error.message}`);
  if (push.error) throw new Error(`post-apply: aix_usage_logs: ${push.error.message}`);
  if (idDoc.error) throw new Error(`post-apply: messages: ${idDoc.error.message}`);
  const row = (conv.data ?? null) as { status?: string | null; is_post_apply?: boolean | null; status_manual_back_at?: string | null; deepseek_cutoff_at?: string | null } | null;
  const first = (r: Res): string | null => (((r.data ?? []) as Array<{ created_at?: string | null }>)[0]?.created_at ?? null);
  return {
    status: row?.status ?? null,
    isPostApply: row?.is_post_apply === true,
    applicationPushAt: first(push),
    idDocumentAt: first(idDoc),
    statusManualBackAt: row?.status_manual_back_at ?? null,
    deepseekCutoffAt: row?.deepseek_cutoff_at ?? null,
  };
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
export function deepseekSafeCutoff(f: PostApplyFacts): DeepseekCutoff {
  try {
    if (resolvePostApply(f).postApply) return null;
    // 書いてあるのに読めない時刻がある＝判定が読めない → 渡さない
    for (const v of [f.applicationPushAt, f.idDocumentAt, f.statusManualBackAt, f.deepseekCutoffAt]) if (v && ms(v) === null) return null;
    const pushAt = ms(f.applicationPushAt), docAt = ms(f.idDocumentAt);
    const latest = Math.max(pushAt ?? -Infinity, docAt ?? -Infinity);
    const cut = ms(f.deepseekCutoffAt), back = ms(f.statusManualBackAt);
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
 */
export type CutoffMark = { kind: "all" } | { kind: "cut"; at: string } | { kind: "blocked" };
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
