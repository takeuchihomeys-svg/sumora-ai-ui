// scripts/lib/exam-night-jobs.ts — 試験の係（exam-conductor --run）が晩の初めに1回流す費用0の仕事（LLM なし・重い読み可の時間だけ）
// 2026-11-25 作業員A（統括役の決め: 新しい Vercel の cron は足さない・毎晩手で流すと抜ける）
//   ① 駅ごとの元の数: audit-route-progress-takeuchi --days=60 --json → audit-route-station-daily --from --write（台帳 #687）
//   ② AIX の外れの組ごとの数: audit-aix-miss-causes --days=30 --write（台帳 #688・毎朝の self-improve も数えるが、晩にも書いておく）
//   ③ 前の on の回から覚えた表: build-learned-reach --days=60（exam-cache/learned-reach.json・台帳 #683）
//   晩＝JST 22時〜翌6時。晩の鍵は「JST の日付を12時で切った日」（22時と翌2時は同じ晩）。止める: EXAM_NIGHT_ZERO_COST=off
export function nightKeyOf(nowMs: number): string { return new Date(nowMs + 9 * 3_600_000 - 12 * 3_600_000).toISOString().slice(0, 10); }
export function nightZeroCostDue(lastKey: string | null | undefined, nowMs: number, env: Record<string, string | undefined> = {}): { due: boolean; key: string } {
  const key = nightKeyOf(nowMs);
  if ((env.EXAM_NIGHT_ZERO_COST ?? "").trim().toLowerCase() === "off") return { due: false, key };
  const h = new Date(nowMs + 9 * 3_600_000).getUTCHours();
  const night = h >= 22 || h < 6;
  return { due: night && lastKey !== key, key };
}
/** 流す台本（順に・前が落ちても次は流す）。json は係の置き場の印のフォルダに置く */
export function nightZeroCostSteps(jsonPath: string): Array<{ name: string; args: string[]; timeoutMin: number }> {
  return [
    { name: "駅ごとの元の数（60日の照らし）", args: ["scripts/audit-route-progress-takeuchi.ts", "--days=60", "--max-conv=400", "--first-move", `--json=${jsonPath}`], timeoutMin: 40 },
    { name: "駅ごとの物差し（quality_daily）", args: ["scripts/audit-route-station-daily.ts", `--from=${jsonPath}`, "--days=60", "--write"], timeoutMin: 15 },
    // 2026-11-25 作業員A（#745 ③）: 逆算の計画の この先 の当たり（同じ照らしの json・DB は書くだけ）
    { name: "地図の先読みの当たり（quality_daily）", args: ["scripts/audit-route-backplan-hit.ts", `--from=${jsonPath}`, "--write"], timeoutMin: 5 },
    // 2026-11-26 作業員A（#745 の直し④）: 竹内さんの先読みとの一致（主の物差し・竹内さん本人の文を軽く読む）
    { name: "竹内さんの先読みとの一致（quality_daily）", args: ["scripts/audit-route-backplan-miss.ts", `--from=${jsonPath}`, "--write"], timeoutMin: 10 },
    // 2026-11-26 作業員A（竹内さん 11/26 昼）: 次の石に向かった割合（同じ照らしの json・ブレインの判断は会話ごとに日付で読む）
    { name: "次の石（quality_daily）", args: ["scripts/audit-route-next-stone.ts", `--from=${jsonPath}`, "--write"], timeoutMin: 10 },
    // 2026-11-26 作業員A（竹内さん 11/26「仕組化」）: 連鎖の型を竹内さん本人の新しい番から数え直す（同じ照らしの json・型の n・一手・ブレインとの一致）
    // 2026-11-26 作業員A: 連携の一覧の升を本番の記録（digest.mtk）から数え直す
    { name: "連携の升の数え直し（quality_daily）", args: ["scripts/audit-linkage-gap-recount.ts", "--days=1", "--write"], timeoutMin: 5 },
    { name: "連鎖の型（quality_daily）", args: ["scripts/audit-chain-patterns.ts", `--from=${jsonPath}`, "--write"], timeoutMin: 10 },
    // 2026-11-26 作業員A（#662）: 統括の受け持ち表（持つ／使う／反映する・7日・DB は書くだけ）
    { name: "統括の受け持ち表（quality_daily）", args: ["scripts/audit-conductor-ownership.ts", "--days=7", "--write"], timeoutMin: 5 },
    { name: "AIX の外れの組ごとの数（quality_daily）", args: ["scripts/audit-aix-miss-causes.ts", "--days=30", "--write"], timeoutMin: 15 },
    // 2026-11-25 作業員A（#683・L と表を1本に）: 前の on の回から覚えた表（exam-cache/learned-reach.json・L の reachRowOf が読む）
    { name: "覚えた表（learned-reach.json）", args: ["scripts/build-learned-reach.ts", "--days=60"], timeoutMin: 10 },
    // 2026-11-26 作業員L（#799 ③）: 本番（Claude）と試験（DeepSeek）の割れの型の表（claude-split-learned.json・Claude の確かめの関所が手の表と重ねて読む・ファイルだけ）
    { name: "割れの型の表（claude-split-learned.json）", args: ["scripts/build-claude-split.ts"], timeoutMin: 5 },
    // 2026-11-26 作業員L（#799 ④）: on にした直しの試験での差と本番の一致の動き（7日・14日・quality_daily on_after:*・#610 の突き合わせ）
    { name: "on の後の本番の動き（quality_daily）", args: ["scripts/audit-on-after.ts", "--write"], timeoutMin: 5 },
    // 2026-11-26 作業員L（竹内さん「統括の連携と優先度・かなり重要」）: MATERIAL_PRIORITY の shadow の当たり（前の24時間・quality_daily mp:shadow_hit・11/30 の組の効く問題の元）
    { name: "MATERIAL_PRIORITY の shadow の当たり（quality_daily）", args: ["scripts/audit-material-priority-hit.ts", "--hours=24", "--write"], timeoutMin: 10 },
    // 2026-11-27 作業員L（#803 試験の辞書）: 問題の定義・要る材料・前の on の覚え・揺れを1つの表に（exam-cache/exam-dictionary.json・ファイルだけ）と前の7晩の物差し
    { name: "試験の辞書（exam-dictionary.json）", args: ["scripts/build-exam-dictionary.ts", "--eval"], timeoutMin: 5 },
    // 2026-11-27 作業員L（#816 スイッチの一生の台帳）: 既定 off の部品ごとの1行と「試す／退役／印が先」の候補（exam-cache/switch-life.json・朝の1枚の1行・DB は台帳と設計知見の軽い読み・積まない）
    { name: "スイッチの一生（switch-life.json）", args: ["scripts/switch-life.ts", "--write"], timeoutMin: 30 },
    // 2026-11-28 作業員L（#806 お客様のカルテ）: 前の7日の会話にカルテの計算を当てて、出る割合・欄ごとの埋まり・審査の事情で落とした欄を数える（quality_daily karte:*・本番の会話を軽く読む・LLM 0）
    { name: "お客様のカルテの物差し（quality_daily karte:*）", args: ["scripts/audit-customer-karte.ts", "--days=7", "--max-conv=150", "--write", "--wait-min=20"], timeoutMin: 15 },
    // 2026-11-28 作業員L（統括役の決め・試験の費用は llm_usage_logs の名札で数えるのが正）: 前の3晩の 係の試験・手元の試験・ほか（DB の関数 exam_cost_by_night の集計1本・LLM 0）
    { name: "試験の費用の名札ごとの数え（quality_daily exam_cost:*）", args: ["scripts/audit-exam-cost-daily.ts", "--nights=3", "--write"], timeoutMin: 5 },
    // 2026-11-28 作業員L（#664 約束の一生）: 段ごとの数（promise_life:*）は 11/25 に1回書いたきりで、朝の1枚が古い数を出し続けていた＝毎晩数え直す。
    //   元の3本（種類の網は本番と同じ＝PROMISE_KIND_WIDE2 だけ on・B1・閉じた時刻）を係の置き場の json に書き、最後の1本が quality_daily に書く（LLM 0）
    { name: "約束の種類の数え（約束の一生の元）", args: ["scripts/audit-promise-kinds.ts", "--days=14", "--wide2", `--out=${jsonPath}.promise-kinds.json`], timeoutMin: 15 },
    { name: "約束を期限内に果たした割合 B1（約束の一生の元）", args: ["scripts/audit-promise-kept.ts", "--days=30", "--max-convs=400", `--out=${jsonPath}.promise-b1.json`], timeoutMin: 30 },
    { name: "約束の閉じた時刻（約束の一生の元）", args: ["scripts/list-done-at-backfill.ts", "--days=60", `--out=${jsonPath}.promise-done.json`], timeoutMin: 10 },
    { name: "約束の一生の段ごとの数（quality_daily promise_life:*）", args: ["scripts/audit-promise-lifecycle.ts", `--kinds=${jsonPath}.promise-kinds.json`, `--b1=${jsonPath}.promise-b1.json`, `--done=${jsonPath}.promise-done.json`, "--write"], timeoutMin: 5 },
    // 2026-11-26 作業員L（#799 ⑤）: 週の全部 on の組の候補（土曜の晩だけ作る・係の置き場の md に足すだけ・積まない）
    //   統括役 11/26 の決め: 土曜に作って係の候補（memory/night_bundle_candidates.md・係の作業ツリーから ../../../memory）に足し、日曜の晩に流す
    { name: "週の全部 on の組の候補（土曜だけ）", args: ["scripts/plan-week-combo.ts", "--weekly", "--write=../../../memory/night_bundle_candidates.md"], timeoutMin: 5 },
  ];
}
