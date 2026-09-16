/**
 * 会話ステータス定数の単一ソース（single source of truth）
 * 以前は8ファイルで独立定義され値が食い違っていた問題を解消（2026-09-02）
 *
 * 値の正は brain-core.ts / bg-async 系で運用されていた実値に統一：
 * - BRAIN_SKIP_STATUSES: applying/screening を含めない（全成約が通過する
 *   申込フェーズのため brain 分析対象。平均42日・169件の学習例あり）
 * - DRAFT_SKIP_STATUSES: bg-async / line-webhook / generate-reply /
 *   analyze-diffs で使われていた8値セット。generate-pending-drafts
 *   （lost/approved 欠落）と generate-draft-bg（4値のみ）の欠落バグを修正
 */

/**
 * Brain分析をスキップするステータス（成約・終了・承認済み会話）
 * 配列である理由: brain/list・cron/brain-sweep が Supabase の
 * `not.in.(${...join(",")})` フィルタ構築に使うため（Set不可）
 */
export const BRAIN_SKIP_STATUSES: string[] = [
  "contract",
  "closed_won",
  "closed_lost",
  "lost",
  "approved",
];

/** ドラフト自動生成をスキップするステータス（申込フェーズ以降すべて） */
export const DRAFT_SKIP_STATUSES = new Set([
  "applying",
  "application",
  "screening",
  "contract",
  "closed_won",
  "closed_lost",
  "lost",
  "approved",
]);

/** bg-async / line-webhook がスキップするステータス（DRAFT_SKIP_STATUSESと同値） */
export const BG_ASYNC_SKIP_STATUSES = DRAFT_SKIP_STATUSES;

// ─── 初回対応（初回の挨拶）かどうか ───
// 2026-09-14 竹内（朱莉事例）「なんでこれ初回応対になっていないのか」: こちらがまだ何も送っていない会話は、状態（status）に関係なく初回対応。
//   旧: bg-async・cron・画面（2か所）が「スタッフ未返信 かつ status=hearing の時だけ first_reply」を別々に持っていた。
//   line-webhook は条件フォームを受けると status を proposing に自動で上げるため、フォームから始まるお客様（TikTok 経由に多い）は
//   初回の挨拶（はじめまして・担当の名乗り）が付かず「ご条件お送り頂きありがとうございます」から始まった。
//   実データ（45日）: 最初の返信の前に条件フォームで proposing に上がった51件のうち42件で、スタッフの最初の手打ち返信は「はじめまして」。
//   AIX を先に送っていた会話（2件）はその後の手打ち返信に「はじめまして」なし → AIX も「こちらが送った」に数える（画像・動画だけは数えない）。
//   内覧以降（viewing・申込・成約）は外で対応済みの可能性があるので status のまま
const FIRST_REPLY_ELIGIBLE_STATUSES = new Set([
  "", "first_reply", "new_inquiry", "initial", "new",
  "hearing", "condition_hearing", "property_search", "searching",
  "proposing", "property_recommendation", "availability_check", "estimate_request",
]);
const MEDIA_ONLY_STAFF_RE = /^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/;

/** こちら（スタッフ・AIX）が文字のメッセージを1通でも送ったか（画像・動画・スタンプだけは数えない） */
export function staffHasEngaged(messages: ReadonlyArray<{ sender?: string | null; text?: string | null }>): boolean {
  return messages.some((m) => m.sender === "staff" && !!(m.text ?? "").trim() && !MEDIA_ONLY_STAFF_RE.test(m.text ?? ""));
}

/** 返信を作る時の状態: こちらがまだ何も送っていない初期の会話なら "first_reply"（初回の挨拶を付ける）。それ以外は null（呼び出し側の status のまま） */
export function firstReplyStateOrNull(status: string | null | undefined, staffEngaged: boolean): "first_reply" | null {
  if (staffEngaged) return null;
  return FIRST_REPLY_ELIGIBLE_STATUSES.has((status ?? "").trim()) ? "first_reply" : null;
}

/**
 * AIX誘導タスク（line_tasks.task_type）のうち、進行中ならドラフト自動生成を
 * スキップするもの（property_check は短い返しを生成するため含めない）
 */
export const AIX_SKIP_TYPES = new Set(["property_send", "estimate_sheet"]);

/**
 * 状態の段階の順位（大きいほど先の段階）。審査管理（screening-admin）の状態名（property_recommendation 等）も含む。
 * 2026-09-14 竹内（タクミ事例）: 同期で状態を後戻りさせない判定（resolveSyncedStatus）に使う
 */
export const STATUS_STAGE_RANK: Readonly<Record<string, number>> = {
  new_inquiry: 0,
  first_reply: 1, hearing: 1, condition_hearing: 1, property_search: 1,
  proposing: 2, property_recommendation: 2, availability_check: 2, estimate_request: 2,
  viewing: 3,
  applying: 4, application: 4,
  screening: 5, approved: 5,
  contract: 6,
  closed_won: 7,
};
/** スタッフが決める終わりの状態（同期では入れない・外さない） */
const STAFF_OWNED_TERMINAL = new Set(["closed_won", "closed_lost", "lost", "contract"]);

/**
 * 審査管理からの同期で書いてよい状態（書かない時は null）。
 * 2026-09-14 竹内（タクミ事例）「申込中にしているのに物件提案中に戻ってしまう」:
 *   審査管理も同じ LINE を受けて自分の会話を更新するたびに sync-from-screening が呼ばれ、先方の状態（property_recommendation）で
 *   こちらの状態を無条件に上書きしていた（申込中にした後、お客様の「よろしくお願い致します！」で物件提案中に戻った）。
 *   状態はこちら（AIXLINX）でスタッフが管理しているので、同期は「まだ状態が無い会話に入れる」「先の段階へ進める」だけにし、後戻り・同じ段階の言い換え・
 *   終わりの状態（成約・失注）の出し入れはしない。申込後（is_post_apply）の会話は申込より前に戻さない
 */
export function resolveSyncedStatus(
  current: string | null | undefined,
  incoming: string | null | undefined,
  opts: { isPostApply?: boolean } = {},
): string | null {
  const inc = (incoming ?? "").trim();
  if (!inc) return null;
  const cur = (current ?? "").trim();
  if (!cur) return inc;
  if (STAFF_OWNED_TERMINAL.has(cur) || STAFF_OWNED_TERMINAL.has(inc)) return null;
  const incRank = STATUS_STAGE_RANK[inc];
  if (incRank === undefined) return null;
  const curRank = Math.max(STATUS_STAGE_RANK[cur] ?? -1, opts.isPostApply ? STATUS_STAGE_RANK.applying : -1);
  return incRank > curRank ? inc : null;
}

/**
 * 審査管理からの同期（sync-from-screening）で状態を書くか。書かない時 status は null。lastSeen は次に覚えておく審査管理の状態。
 * 2026-09-15 竹内（隼斗事例）「申込して審査が否決となって物件提案中に戻したお客さんが、時間経過したら申込・審査中に戻ってしまう」:
 *   審査管理の状態は否決の後も「screening」のまま。審査管理も同じ LINE を受けて自分の会話を更新するたびに同期が呼ばれ、
 *   「先の段階へ進める」（resolveSyncedStatus）で物件提案中（2）→ 審査中（5）に何度も戻していた（スタッフが手で4回戻した・同期の書き込みは履歴なし）。
 *   同期が状態を動かすのは、審査管理の状態が前回の同期から変わった時（新しい出来事）だけにする。同じ値が届き続けるだけならスタッフの判断のまま。
 *   前回の値を覚えていない（この仕組みの導入前の会話）時は、今回の値を覚えるだけで状態は動かさない（導入直後に一斉に審査中へ戻さない）
 */
export function resolveScreeningSync(
  current: string | null | undefined,
  incoming: string | null | undefined,
  lastSeen: string | null | undefined,
  opts: { isPostApply?: boolean; manualBack?: boolean } = {},
): { status: string | null; lastSeen: string | null } {
  const inc = (incoming ?? "").trim();
  if (!inc) return { status: null, lastSeen: (lastSeen ?? "").trim() || null };
  const cur = (current ?? "").trim();
  if (!cur) return { status: inc, lastSeen: inc };               // 状態がまだ無い会話には入れる（従来どおり）
  // 2026-09-16 竹内（𝒮 さん事例）「一度審査中にしても物件提案中に戻すとそのまま物件提案中にする。自動で審査中に戻ってしまうことがある」:
  //   スタッフが手で前の段階に戻した会話は、その後に審査管理の状態が変わっても同期では動かさない（戻した判断が正）。
  //   審査管理は否決・見送りの後も screening のまま持ち続け、別の値に変わった瞬間に「先へ進める」で審査中に戻していた。
  //   また進めたい時はスタッフが手で進める（その時に印は消える）
  if (opts.manualBack) return { status: null, lastSeen: inc };
  const prev = (lastSeen ?? "").trim();
  if (!prev || prev === inc) return { status: null, lastSeen: inc }; // 審査管理の状態が変わっていない → スタッフの判断のまま
  return { status: resolveSyncedStatus(cur, inc, opts), lastSeen: inc };
}

/**
 * 手で状態を変えた時に「後戻りの印（status_manual_back_at）」を付けるか外すか。
 *   後戻り（段階が下がる）→ 付ける（同期で自動で前に戻さない）／前に進める・同じ段階 → 外す（また同期に任せる）
 * 2026-09-16 竹内（𝒮 さん事例）。終わりの状態（成約・失注・契約）へ動かした時は印を外す（同期はもともと触らない）
 */
export function resolveManualBackMark(from: string | null | undefined, to: string | null | undefined): "set" | "clear" {
  const f = (from ?? "").trim();
  const t = (to ?? "").trim();
  if (!t || STAFF_OWNED_TERMINAL.has(t)) return "clear";
  const fr = STATUS_STAGE_RANK[f];
  const tr = STATUS_STAGE_RANK[t];
  if (fr === undefined || tr === undefined) return "clear";
  return tr < fr ? "set" : "clear";
}
