/**
 * リセットの事実（数字と目印）の正本（2026-11-26 竹内さん「順に改善」→ C: 骨組みと決まりの二重管理をなくす）
 *
 *   ・骨組み（action-playbook.ts の PLAYBOOK_FLOW_SERIES・PLAYBOOK_EXTRA_GUIDES）と
 *     決まり（auto-procedure-rules.ts）は、ここの値を読んで文を作る。手で数字を2か所に書かない。
 *   ・値を変えるなら、ここだけ変える → 試験 reset-facts-single-source が両方の文に入っているかを見る。
 *   ⚠ 拡張の実際の待ち時間（page-script.js）はこの値に従っている（2.8.292 以降）。値を変えるなら拡張も直す。
 */
/** リセットボタンの大きさ（人が押した形・2.8.287） */
export const RESET_BUTTON_SIZE = "幅160×高さ30";
/** リセット後のラグ待ち（30秒以上・3回に分けて・2.8.292） */
export const RESET_WAIT_MIN_SEC = 30;
export const RESET_WAIT_RANGE = "30〜34秒・3回に分けて";
/** 待ちの文（骨組みの手に使う） */
export const RESET_WAIT_TEXT = `${RESET_WAIT_MIN_SEC}秒以上（${RESET_WAIT_RANGE}）`;
/** リセットを押した後、押せたかを確かめるまでの待ち（2.8.316・竹内さん「止まって120秒以上」）。15秒で「押せず」と決めない */
export const RESET_PRESS_WAIT_TEXT = "最大120秒まで押すのを待つ（15秒で「押せず」と決めない・裏は130秒まで待つ）";
/** 並べ替えの高→低を押した後の画面の追いつき（ラグ）の猶予（2.8.317・竹内さん「押した後の猶予も15秒〜」・毎回揺らす）。リセットの後には置かない（リセットは30〜34秒の待ちだけ） */
export const LAG_GRACE_TEXT = "15〜20秒";
/** 検索を押す前に条件を見直す間（2.8.317・竹内さん「10秒ほどたって検索を押す」） */
export const SEARCH_REVIEW_TEXT = "9〜12秒";
/** 検索確認（把握）から並べ替えの最初の操作までの待ち（2.8.317・竹内さん「検索後かたまるので40〜50秒」） */
export const SORT_AFTER_SEARCH_TEXT = "40〜50秒";
