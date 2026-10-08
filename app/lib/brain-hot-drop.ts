// app/lib/brain-hot-drop.ts
// hot（今日物件を出すべき人）から外す判断（純関数・DB なし）。ブレインの判断（brain-attention）が使う。
//
// 2026-10-08 竹内さんの決定（原文）:「hot から外す事もブレインがしてよい」「外す基準あるはず。AIX 3回連続無視等」
//   訂正（同日）:「hot から外すのは3回無視された人になっていないか？ 追客3回無視」「追客は AIX の物件ピックアップ または 物件オススメ」
//   → 追客＝お客様の最後の発言の後に送った AIX【物件ピックアップした】（property_send）か AIX【物件オススメ】（property_recommendation・新着1件を含む）
//     だけを数える（手打ち・他の AIX は数えない・同じ JST の日は1回）。3回続けて返事なし（3回目から3日待つ）で hot から外す
//   外した後にお客様の反応が戻れば、その発言でブレインが走り直し（syncBrainHot）、再び hot に上がる。
//   物件の中身（どの物件を出すか）は物件検索ブレインの領分。ここは「誰に毎日物件を出すか」だけ。
//
// 今まであった外す基準（洗い出し・2026-10-08）:
//   ① 旧ターゲット全リスト（announce-hot-customers・BRAIN_TARGET_LIST=off の側）: AIX を送った日（JST・1日何回でも1）のうち
//      その後にお客様の返信が無い日が3日以上 → is_flagged を外して「AIXを3日間無視されたため要対応から外しました」
//   ② 物件のツール（/api/property-customers PATCH）: hot で返信なしのまま物件を2回送った → property_search（送付回数の数え）
//   ③ 自動検索（auto-search-plan）: 送付も発言も8日以上無い → dormant（hot の人だけは dormant_hot＝毎日のまま）・30日動き無しで off
//   ④ AIX要対応の取り下げ（aix-item-cleanup brainPausedCustomer）: 止まった・断った（hesitancy・intent=negative）
//
// 線の根拠（追客の数え方・本番・YUMA を除く・aix_usage_logs の property_send／property_recommendation・2026-10-08 測定）:
//   追客が n 回目まで続けて返事なしで、その後3日返事が無かった時、33日以内にお客様が戻った割合
//     n=1: 42/107（39%・内覧 13）／ n=2: 12/43（28%・内覧 5）／ n=3: 2/17（12%・いつかは 3/17＝18%・内覧 1）／ n>=4: 0/8
//   → 追客3回で外す。戻る 12% はお客様の発言でブレインが再び上げる
// 参考（最初の版・AIX なら何でも・messages の is_aix_generated・180日）:
//   連続で返信の無い AIX の日が n 日目になり、その後3日返事が無かった時、33日以内にお客様が戻った割合
//     n=1: 66/137（48%・その後の内覧 21）／ n=2: 19/54（35%・内覧 5）／ n=3: 3/16（19%・内覧 1）／ n≥4: 0/8
//   → 3日分の AIX を続けて返事なし（3日目の AIX から3日待つ）で外す。戻る 19% はお客様の発言でブレインが再び上げる。
//     外しても物件の検索は止まらない（property_search＝止まった人の週2回の便。project_search_cadence_plan「要対応から外れた人だけ週2回」）
//   ※ 最優先（①内覧済み ②審査落ち）はターゲット一覧から外さない（竹内さん「最優先」）。hot の印だけは同じ線で外す
//   ※ 今の hot 88人（10/08）にこの線を当てると0人（スタッフは1〜2回で送るのを止めている・こちらから送った日で数えても0人）。
//     hot が溜まっている元は「お客様の発言が長く無い」の方（14日以上 44人・30日以上 35人）→ 2本目の線:
//   お客様の最後の発言から d 日たった時、その後30日以内に戻った割合（240日・YUMA を除く）:
//     14日: 68/304（22%・内覧 10）／21日: 28/241（12%・内覧 5）／30日: 13/207（6%・内覧 2）／45日: 11/172（6%・内覧 1）
//   → 2本目の線: お客様の発言が30日を超えて無い人も外す（10/08 竹内さん「30日を超えたら外す」＝発言が止まった後に追客を送っていない人）。
//     HOT_DROP_SILENT_DAYS=off で止める・数字で日数を変える

const DAY = 86_400_000;

/** 続けて返事の無い追客（AIX 物件ピックアップした／物件オススメ・JST の日ごとに1回）の数がこれ以上で外す */
export const HOT_DROP_IGNORED_AIX_DAYS = 3;
/** 最後の追客からこの日数お客様の返事が無ければ外す（その追客への返事を待つ） */
export const HOT_DROP_WAIT_DAYS = 3;
/** 追客に数える AIX（物件を届ける AIX・aix-task-link PROPERTY_DELIVERY_AIX と同じ） */
export const FOLLOWUP_AIX_TYPES: readonly string[] = ["property_send", "property_recommendation"];

/** 2本目の線の日数の既定（10/08 竹内さん「30日を超えたら外す」） */
export const HOT_DROP_SILENT_DAYS = 30;

/** 2本目の線の日数（環境変数 HOT_DROP_SILENT_DAYS: 無し＝30・数字＝その日数・off＝使わない） */
export function silentDaysSetting(v: string | null | undefined): number | null {
  const x = (v ?? "").trim().toLowerCase();
  if (x === "off") return null;
  const n = Number(x);
  return x && Number.isFinite(n) && n > 0 ? n : HOT_DROP_SILENT_DAYS;
}

const jstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);

export type IgnoredAix = { days: number; lastAixAt: string | null };

/**
 * お客様の最後の発言より後に送った追客（AIX 物件ピックアップした／物件オススメの送信の時刻）を JST の日ごとに数える。
 *   1日に何通送っても1。時刻の元は呼ぶ側が FOLLOWUP_AIX_TYPES で絞る
 */
export function ignoredFollowUpStreak(aixSentAt: Array<string | null | undefined>, lastCustomerAt: string | null | undefined): IgnoredAix {
  const cust = lastCustomerAt ? Date.parse(lastCustomerAt) : NaN;
  const days = new Set<string>();
  let last: string | null = null;
  for (const t of aixSentAt) {
    if (!t) continue;
    const v = Date.parse(t);
    if (!Number.isFinite(v)) continue;
    if (Number.isFinite(cust) && v <= cust) continue;
    days.add(jstDay(t));
    if (!last || v > Date.parse(last)) last = t;
  }
  return { days: days.size, lastAixAt: last };
}

/**
 * hot から外すか。
 *   - 続けて返事の無い追客が HOT_DROP_IGNORED_AIX_DAYS 回以上・最後の追客から HOT_DROP_WAIT_DAYS 日以上たった
 *   - スタッフが最後の AIX より後に「今日も hot で回す」と確かめた（hot_confirmed_at）時は外さない
 */
/** 旧名（最初の版） */
export const ignoredAixStreak = ignoredFollowUpStreak;

export function brainHotDrop(i: {
  ignored: IgnoredAix | null | undefined;
  hotConfirmedAt?: string | null;
  /** お客様の最後の発言（無ければ silentSince から数える） */
  lastCustomerAt?: string | null;
  /** 会話を始めた時刻（発言が一度も無い人の数え始め） */
  silentSince?: string | null;
  /** 2本目の線の日数（null＝使わない）。省略＝使わない（呼ぶ側が silentDaysSetting で渡す） */
  silentDays?: number | null;
  nowMs: number;
}): { drop: boolean; reason: string | null } {
  const conf = i.hotConfirmedAt ? Date.parse(i.hotConfirmedAt) : NaN;
  if (i.silentDays) {
    const from = i.lastCustomerAt ?? i.silentSince ?? null;
    const f = from ? Date.parse(from) : NaN;
    const silent = Number.isFinite(f) ? (i.nowMs - f) / DAY : NaN;
    // スタッフがその後に hot を確かめた時は外さない
    if (Number.isFinite(silent) && silent > i.silentDays && !(Number.isFinite(conf) && i.nowMs - conf < i.silentDays * DAY))
      return { drop: true, reason: `お客様の発言が${Math.floor(silent)}日なし` };
  }
  const g = i.ignored;
  if (!g || g.days < HOT_DROP_IGNORED_AIX_DAYS || !g.lastAixAt) return { drop: false, reason: null };
  const last = Date.parse(g.lastAixAt);
  if (!Number.isFinite(last) || i.nowMs - last < HOT_DROP_WAIT_DAYS * DAY) return { drop: false, reason: null };
  if (Number.isFinite(conf) && conf > last) return { drop: false, reason: null };
  return { drop: true, reason: `追客（物件ピックアップ・物件オススメ）${g.days}回 続けて返事なし（最後の追客から${Math.floor((i.nowMs - last) / DAY)}日）` };
}
