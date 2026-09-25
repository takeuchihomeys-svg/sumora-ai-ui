// app/lib/rp-update-days.ts
// リアプロの「更新日」（N日以内）をお客様ごとに1つに決める純関数（DB 依存なし・画面からも使える）。
//
// 2026-09-25 竹内「更新日も拡張ツールと連動」:
//   拡張（popup.js の preloadAdjForm）は「アプリで上書きした値（rp_update_days）→ 無ければ前回そのお客様に物件を出した日
//   （送った日と確認した日の新しい方・JST の日付）から 1/3/7/14」で決めている。
//   ウェブ（app/page.tsx・app/customers/page.tsx の calcRpUpdateDays）は「送った日だけ・時刻の差」で数えていたので、
//   確認だけの人は空（すべて表示）になり、朝の送信は1日ずれることがあった → ここに1本化して同じ値にする。
//
// 拡張の写し: chrome-extension/rp-update-days.js（self.AxlxRpUpdateDays）。テスト（app/lib/__tests__/rp-update-days.test.ts）で
//   2つが一字一句同じ答えを返すことを確かめる（直したら両方直す＝四者同名）。
import { lastPropertyTouchAt, rpUpdateDaysFor } from "./auto-search-schedule";

/** 更新日を決めるのに使う列だけ */
export type RpUpdateDaysCustomer = {
  /** アプリ・拡張で手で決めた値（1/3/7/14）。null＝自動 */
  rp_update_days?: number | null;
  last_property_sent_at?: string | null;
  property_viewed_at?: string | null;
};

/** 選べる値（拡張の select・ウェブの切替と同じ） */
export const RP_UPDATE_DAYS_CHOICES = [1, 3, 7, 14] as const;

/** 手で決めた値か（1 以上の数だけ。0・負・NaN は「決めていない」＝拡張の `if (c.rp_update_days)` と同じ線） */
export function manualRpUpdateDays(c: RpUpdateDaysCustomer | null | undefined): number | null {
  const v = c?.rp_update_days;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** 自動の値: 前回そのお客様に物件を出した日（送った日と確認した日の新しい方）から 1/3/7/14。初めては null（絞らない） */
export function autoRpUpdateDays(c: RpUpdateDaysCustomer | null | undefined, nowMs: number = Date.now()): number | null {
  if (!c) return null;
  return rpUpdateDaysFor(lastPropertyTouchAt({ last_property_sent_at: c.last_property_sent_at ?? null, property_viewed_at: c.property_viewed_at ?? null }), nowMs);
}

/** 実際に使う更新日: 手で決めた値 → 無ければ自動（拡張の preloadAdjForm と同じ順） */
export function effectiveRpUpdateDays(c: RpUpdateDaysCustomer | null | undefined, nowMs: number = Date.now()): number | null {
  return manualRpUpdateDays(c) ?? autoRpUpdateDays(c, nowMs);
}
