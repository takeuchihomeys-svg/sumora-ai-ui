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
import { buildPlaybook } from "./action-playbook";
import { cleanOpenerCheckboxCopies } from "./field-name-aliases";

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
};

/** 束を書く形に整える（束を直接書き換える）。 */
export function prepareBundleForWrite(bundle: Record<string, unknown>): PrepareBundleResult {
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
  let playbook_ok = false;
  let playbook_ver_bumped = false;
  try {
    const prevRv = String((bundle.playbook as { rules_v?: string } | null | undefined)?.rules_v ?? "");
    bundle.playbook = buildPlaybook(bundle as never);
    playbook_ok = true;
    const nextRv = String((bundle.playbook as { rules_v?: string } | null | undefined)?.rules_v ?? "");
    if (nextRv && nextRv !== prevRv) {
      bundle.generated_at = new Date().toISOString();
      playbook_ver_bumped = true;
    }
  } catch {
    // 手順書が作れなくても束は書く（拡張は手順書無しで動く）
  }
  return { names_stripped, playbook_ok, opener_copies_removed, playbook_ver_bumped };
}
