/**
 * 今日の強化を1件ずつ記録する（2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」）
 *
 *   npx tsx --env-file=.env.local scripts/save-improvements.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/save-improvements.ts
 *   npx tsx --env-file=.env.local scripts/save-improvements.ts --summary   # 何件・どの分野か
 *
 * ⚠ 同じ title は二度足さない（何度流しても増えない）。
 * ⚠ 実測の数字を必ず入れる（推測で「良くなった」と書かない）。
 */
import { saveImprovement, improvementSummary, type Improvement } from "../app/lib/learn-improvements";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const summaryOnly = args.includes("--summary");

const version = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(process.cwd(), "chrome-extension", "manifest.json"), "utf8"));
    return String(m.version || "");
  } catch { return null; }
})();

/**
 * 2026-11-14 に実際に直した物（**実測の数字つき**）。
 * ⚠ ここに書くのは「何を・なぜ（数字）・どう直した・効くはずの所」。
 *   効いたかどうかは**まだ分からない**物は effect に「確かめる」と書く（良くなったと決めない）。
 */
const TODAY: Improvement[] = [
  {
    area: "検索",
    title: "検索が「止まった」と誤判定される原因2つを直した",
    why: "実測（7日）: abandoned 254件 / finished 60件。abandoned 254件すべて result が空。最後に押したのは17回とも click:検索（所在地では止まっていない）。07:55:05 に検索 → 20分後の 08:15:07 に捨てられていた。",
    how: "① 拡張の1回の上限20分とサーバーの見回り20分が競争していた → STALL_MINUTES を35分に。② 見回りが先に abandoned にすると後から届いた本物の finished を捨てていた → abandoned を finished に上げ直す（3時間以内）。",
    effect: "完走率（finished / 全回）が上がる・abandoned の result が空でなくなる",
    verify: "npx tsx --env-file=.env.local scripts/supervisor-talk.ts（完走率を見る）",
    version: null,
  },
  {
    area: "自動",
    title: "自動便は日ごとに完結（前日の分を翌日へ持ち越さない）",
    why: "実測: 拾われた825件のうち12件が便の日≠実行日（前日の午後の便が翌日の0〜2時に8〜9時間遅れで実行）。",
    how: "payload.jst_date が今日でない auto_schedule をその場で cancelled に閉じる・cron の openIds から前日分を外す・統括が previous_day_closed を言葉にする。",
    effect: "日をまたいだ実行が0件になる・前日に届かなかった人が今日の穴にならない",
    verify: "npx tsx --env-file=.env.local scripts/audit-scene-flows.ts --days=2",
    version: null,
  },
  {
    area: "自動",
    title: "土日も自動検索を動かす（設定で戻せる）",
    why: "実測: 土曜の今日、自動便120件が誰にも拾われずに閉じた（workGate が土日を必ず止めていた）。",
    how: "auto-run.workGate の土日停止を既定で外した（時間の決まり9〜23時・12〜13時休憩・90分小休憩は残す）。axlxWeekendOff=1 で元に戻せる。",
    effect: "土日も自動便が動く（月曜まで止まらない）",
    verify: "node tests/chrome-extension/workgate-weekend-v2747.test.js",
    version: "2.7.47",
  },
  {
    area: "物件取得",
    title: "同じ建物・同じ間取り・同じ平米は最安1件だけにした（絞り込みが一度も効いていなかった）",
    why: "実測: 同じ1LDK 29.28㎡ が3部屋（102,600 / 102,300 / 105,000円）すべてダウンロードされていた。原因は _applyCheapestPerLayout が cb.checked で絞っていたが、その時点で1件もチェックされていない（items が常に空）。",
    how: "渡された候補(cand)を対象にする・外すのは __axCheapestSkip の印（チェック状態に頼らない）。",
    effect: "同じ部屋の資料が1件だけになる（PDFが減る・お客様に同じ部屋が並ばない）",
    verify: "node tests/chrome-extension/cheapest-per-sqm-v2748.test.js",
    version: "2.7.48",
  },
  {
    area: "拡張",
    title: "徒歩が選択後に消える原因を直した",
    why: "実測: 自動モードで transportation_id が0件・分数が入る時と入らない時があった。原因は学んだ順に並べ替える処理が『移動手段』と『分数』を入れ替えていた（リアプロは移動手段を選ぶと分数がリセットされる）。",
    how: "移動手段は必ず分数より前に固定（並べ替えの前後で2回そろえる）。",
    effect: "徒歩10分が必ず残る（消えない）",
    verify: "node tests/chrome-extension/walk-not-cleared-v2748.test.js",
    version: "2.7.48",
  },
  {
    area: "拡張",
    title: "録画が操作を拾えていなかった原因を直した（クリック0件）",
    why: "実測: 写真の diag が全部 ring_empty: ring0: seen0: watchundefined。watchundefined は『まだ立ち上がっていない』の印で、human-learn.js が後から来ると永久に立ち上がらなかった。",
    how: "最大3秒待つ（50msおき）・来たら start() を呼ぶ・本体を start() にまとめた。",
    effect: "seen0 が消えて、本物の欄（rental_cost2 など）が記録される",
    verify: "npx tsx --env-file=.env.local scripts/audit-learn-material.ts（操作の並びの割合）",
    version: "2.7.49",
  },
  {
    area: "拡張",
    title: "欄の名前が img / body になっていたのを直した",
    why: "実測（7日）: 学べた欄の8割が img(26回) と body(8回)。本物は 左の次｜td.pager が4回だけ。名前が取れないと『押す位置』を学べない。",
    how: "img/body など欄でない物は① 親（リンク・ボタン・行）の名前を探す ② 無ければ null（ゴミを貯めない）。",
    effect: "記録に本物の欄の名前が入る（img/body が消える）",
    verify: "node tests/chrome-extension/record-revive-fieldname-v2749.test.js",
    version: "2.7.49",
  },
  {
    area: "統括",
    title: "統括の判断が保存できていなかった3つの原因を直した",
    why: "実測: learn_supervisor_log への挿入が new row violates row-level security policy で弾かれた（0件成功）。RLS を有効にしていたため Service Role キーが無いと書けない。さらに保存が投げっぱなし（void async）で失敗を握り潰していた。",
    how: "① RLS を DISABLE にそろえる（表が在っても直す） ② saveSupervisorForBundle を作り API が await する ③ meeting（議題・根拠）も保存する。",
    effect: "統括の判断・議題・根拠が毎回DBに残る（推移を見られる）",
    verify: "npx tsx --env-file=.env.local scripts/check-supervisor-table.ts",
    version: null,
  },
  {
    area: "統括",
    title: "統括が場面ごとの手順を学ぶ（所在地・条件・駅・検索・物件・次のページ）",
    why: "実測: search_audits.filled.ops に人の押した順番が7日で56件中32件あったのに、統括は shot_ops の集計しか見ていなかった（12%しか埋まらない）。",
    how: "learn-flow-steps.ts を作り、場面（area/station/cond/search/list/next）に分ける・弱い場面（手本が無い/迷い/押し直し/待ち）を見つける・統括の議題と根拠に組み込む。",
    effect: "統括が『どの場面の手順を学べているか』を言える・手本が無い場面を名指しできる",
    verify: "npx tsx --env-file=.env.local scripts/audit-scene-flows.ts --days=7",
    version: null,
  },
  {
    area: "統括",
    title: "統括が自分で『次に学ぶ事』を決める（無料→有料の順）",
    why: "統括は『弱い所の一覧』を出すだけで、次に何を学ぶかを自分で決めていなかった（竹内さんが毎回指図する必要があった・実測: 議題は出るが learning_tasks が0件）。",
    how: "learning_tasks を作り、fix_scene（止まる場面）→ need_human（手本が無い場面）→ fix_record（録画の経路）→ photo_learn（写真から欄の種類・上限20枚）の順に並べる。議題にも残す。",
    effect: "統括が『次はこれを学ぶ』と自分で言える・写真は費用がかかるので最後",
    verify: "npx tsx --env-file=.env.local app/lib/__tests__/supervisor-learning-tasks.test.ts",
    version: null,
  },
  {
    area: "学習",
    title: "写真から欄の種類を読む仕組みを繋いだ（作ってあるのに呼ぶ所が0箇所だった）",
    why: "実測: SHOT_LEARN_PROMPT と parseShotLearn は作ってあったのに呼ぶ所が0箇所。だから human_motion_learn.shot_learn が全件0（写真は撮れているのに写真から何も学べていない）。",
    how: "shot-learn-server.ts を作り、Storage の写真を Vision で読んで shot_learn に書き戻す。scripts/shot-learn.ts（--dry-run で費用を確かめてから書く）。",
    effect: "写真から欄の種類（select/input/checkbox）が学べる（shot_learn が0件でなくなる）",
    verify: "npx tsx --env-file=.env.local scripts/shot-learn.ts --dry-run --limit=2",
    version: null,
  },
  {
    area: "統括",
    title: "統括の決定を実行する側が繋がっていなかった（actions しか読んでいなかった）",
    why: "実測: supervisor-do が meeting.learning_tasks を1箇所も読んでいなかった。統括が『次に学ぶ事』を決めても誰も実行しない（判断と実行が切れていた）。",
    how: "fetchAdv が learning_tasks を読み、種類ごとに実行できるようにした（fix_scene / fix_record は無料・photo_learn は --yes-cost の時だけ・need_human は竹内さん）。--run=task:N で実行。",
    effect: "統括が決めた順番どおりに学びが進む（無料→有料・人が要る物は止まる）",
    verify: "npx tsx --env-file=.env.local scripts/supervisor-do.ts",
    version: null,
  },
  {
    area: "統括",
    title: "強化の輪（6つ）を1コマンドで点検できるようにした",
    why: "実測: 今日だけで『輪が切れている』を3回踏んだ（RLS で保存できていない・learning_tasks を実行する側が読んでいない・field_order を見落としていた）。目で追うと見落とす。",
    how: "audit-loop.ts を作り、① 記録（seen0 が消えたか）→ ② 材料（img/body の割合）→ ③ 判断（場面の手順）→ ④ 決定（次に学ぶ事）→ ⑤ 実行（種類が揃っているか）→ ⑥ 確認（判断が保存されているか）を1回で見る。切れている所に『次にやる事』を出す。",
    effect: "輪のどこが切れているかが1コマンドで分かる（強化されているつもりを防ぐ）",
    verify: "npx tsx --env-file=.env.local scripts/audit-loop.ts",
    version: null,
  },
];

void (async () => {
  if (summaryOnly) {
    const s = await improvementSummary(1);
    console.log(`今日の強化: ${s.total}件`);
    for (const b of s.byArea) console.log(`  ${b.area}: ${b.n}件`);
    if (s.error) console.log("読めません:", s.error);
    return;
  }
  console.log(`記録する強化: ${TODAY.length}件${dryRun ? "（dry-run＝書かない）" : ""}  版=${version ?? "-"}`);
  let ok = 0, skipped = 0, ng = 0;
  for (const x of TODAY) {
    const item = { ...x, version: x.version ?? version };
    if (dryRun) {
      console.log(`  [dry] ${item.area} / ${item.title}`);
      continue;
    }
    const r = await saveImprovement(item);
    if (r.ok && r.skipped) { skipped++; console.log(`  = 既にある: ${item.title}`); }
    else if (r.ok) { ok++; console.log(`  + ${item.area} / ${item.title}`); }
    else { ng++; console.log(`  ✗ ${item.title}: ${r.skipped || r.error}`); }
  }
  console.log(`\n追加 ${ok} / 既にある ${skipped} / 失敗 ${ng}`);
  if (!dryRun) {
    const s = await improvementSummary(1);
    console.log(`今日の強化（合計）: ${s.total}件`);
    for (const b of s.byArea) console.log(`  ${b.area}: ${b.n}件`);
  }
})();
