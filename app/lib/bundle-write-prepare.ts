// app/lib/bundle-write-prepare.ts — 学習の束を DB に書く直前に必ず通す（2026-11-20）
//
// ★ 実測（2026-11-20 12:xx）: 名前の除去（stripCustomerNames）と手順書（playbook）は
//   human-learn-profile の API だけで行っていた。写真学習の後の作り直し（shot-learn-server）と
//   毎日の cron（cron/human-learn-brain）は直接 insert していたので、最新の realpro 行に
//   「今の客:〈名前〉」が戻り、playbook も無かった。
//   → 書く経路はすべてこの関数を通す（書き方を揃える）。
//
// ⚠ 呼ぶ順: 引き継ぎ（inheritLinkFoundations）の**後**・insert の**前**。
//   先に呼ぶと、過去の行から名前や古い手順が戻る。
import { stripCustomerNames } from "./bundle-privacy";
import { buildPlaybook, PLAYBOOK_BUILD_V } from "./action-playbook";
import { rulesReviewedUpToFor } from "./auto-itandi-rules";
import { isPlaybookNewerThanCode, pickNewestPlaybook } from "./playbook-freshness";
import { cleanOpenerCheckboxCopies } from "./field-name-aliases";
import { sanitizeBundleForSite } from "./human-motion-sanitize";
import { syncSupervisorSceneFlows, syncSupervisorImproveLoop } from "./learn-bundle-preserve";

export type PrepareBundleResult = {
  names_stripped: boolean;
  playbook_ok: boolean;
  /** 開くボタンの名前から外したチェック欄の写し（拡張が人の押した所の代わりに使ってしまう物） */
  opener_copies_removed: number;
  /**
   * ★ 2026-11-23: 手順書の決まり版が変わったら generated_at を上げた。
   *   実測: attach だけだと generated_at が据え置き → 拡張が same_version で新手順書を取らず read=0・旧 playbook_seen のまま。
   */
  playbook_ver_bumped: boolean;
  /** ★ 2.8.297: いまの手順書がこのコードより新しいので作り直さず残した（古いコードの上書き防止） */
  playbook_kept_newer: boolean;
};

/**
 * 束を書く形に整える（束を直接書き換える）。
 * site: その束のサイト（'itandi' ならリアプロ専用の手を載せない・2026-11-26）。未指定は従来どおり。
 */
export function prepareBundleForWrite(bundle: Record<string, unknown>, site?: string | null): PrepareBundleResult {
  let names_stripped = false;
  try {
    const cleaned = stripCustomerNames(bundle);
    if (cleaned.changed) {
      for (const k of Object.keys(cleaned.value)) bundle[k] = (cleaned.value as Record<string, unknown>)[k];
      names_stripped = true;
    }
  } catch {
    // 名前の除去に失敗しても束は捨てない（呼び元がログに残す）
  }
  let opener_copies_removed = 0;
  try {
    opener_copies_removed = cleanOpenerCheckboxCopies(bundle);
  } catch {
    // 外せなくても束は書く（手順書が mismatch として足りない所に出す）
  }
  try {
    sanitizeBundleForSite(bundle, site);
  } catch {
    // サニタイズ失敗時も束の保存は止めない
  }
  try {
    syncSupervisorSceneFlows(bundle, site);
  } catch {
    // 同期失敗時も束の保存は止めない
  }
  try {
    syncSupervisorImproveLoop(bundle, site);
  } catch {
    // 同期失敗時も束の保存は止めない
  }
  let playbook_ok = false;
  let playbook_ver_bumped = false;
  let playbook_kept_newer = false;
  try {
    const cur = bundle.playbook as (Record<string, unknown> & { rules_v?: string }) | null | undefined;
    const prevRv = String(cur?.rules_v ?? "");
    /**
     * ★ 2.8.297 新しい手順書を古いコードで上書きしない。
     *   候補 = ①いま束が持つ手順書（attach・作り直しの再実行）②引き継ぎが履歴から拾った一番新しい物（inheritLinkFoundations が
     *   列挙されない印 __prev_playbook に載せる＝DB へは書かれない）。このコードより「厳密に」新しい物があれば作り直さず残す。
     *   ＝本番が古いコードのまま動いても、新しい手順書は戻らない（デプロイが遅れても 22時の作り直しで 23件へ戻らない）。
     *   止める: PLAYBOOK_DOWNGRADE_GUARD=off（今まで通り必ず作り直す）。
     */
    let kept: Record<string, unknown> | null = null;
    if (process.env.PLAYBOOK_DOWNGRADE_GUARD !== "off") {
      const hidden = (bundle as { __prev_playbook?: Record<string, unknown> | null }).__prev_playbook;
      const best = pickNewestPlaybook<Record<string, unknown>>([cur ?? null, hidden ?? null].filter(Boolean) as Record<string, unknown>[]);
      if (best && isPlaybookNewerThanCode(best, { upTo: rulesReviewedUpToFor(site), build: PLAYBOOK_BUILD_V })) kept = best;
    }
    try { delete (bundle as { __prev_playbook?: unknown }).__prev_playbook; } catch { /* 列挙されない印なので消えなくても書かれない */ }
    if (kept) {
      bundle.playbook = kept;
      playbook_kept_newer = true;
      playbook_ok = true;
    } else {
      bundle.playbook = buildPlaybook(bundle as never, site);
      playbook_ok = true;
      const nextRv = String((bundle.playbook as { rules_v?: string } | null | undefined)?.rules_v ?? "");
      if (nextRv && nextRv !== prevRv) {
        bundle.generated_at = new Date().toISOString();
        playbook_ver_bumped = true;
      }
    }
  } catch {
    // 手順書が作れなくても束は書く（拡張は手順書無しで動く）
  }
  return { names_stripped, playbook_ok, opener_copies_removed, playbook_ver_bumped, playbook_kept_newer };
}
