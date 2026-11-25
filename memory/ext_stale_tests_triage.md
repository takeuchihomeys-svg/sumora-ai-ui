# 拡張の古い赤の試験の整理（2026-11-26 竹内さん「1本ずつ整理する」）

基準: `tests/chrome-extension/_known-red.json`（未整理の古い赤）。`npx tsx scripts/ext-test-all.ts` が「基準より増えた赤」だけを失敗にする。
直したら `--write-baseline` で縮める（増やさない）。**試験を黙って書き換えて通さない**（振る舞いが変わった可能性のある物は竹内さんに聞く）。

## 1回目（アルファベット順の最初の 10 本・124 → 122 本）

| 試験 | 結果 | 中身 |
|---|---|---|
| active-clock-v2819 | ✅ 直した | 抜き出した関数が `_clearGen` を使うようになり、試験の箱に無かった（ReferenceError）。箱に `_clearGen`／`_clearGenStale` を足した。版の固定（2.8.119 ちょうど）は「以上」へ |
| ad-sort-cursor-path-v28164 | ✅ 直した | 失敗の印を出す関数が `_tmark` → `_liveDlStep` に変わっていた（機能は残っている） |
| leftover-progress-v2825 | △ 5→4 | 箱の不足（`_clearGen`）は直した。残り 4 は下の「本物の疑い」 |
| ad-sort-hilo-v28185 | 要確認 | 「自動中は human_search_done で閉じない」の書き方が `if (_humanRun && _keepAuditOpenAfterFill()) _humanRun = false;` に変わった。同じ意味か、竹内さんの確認が要る |
| audit-not-empty | 要確認 | `_auditReset` が重複判定（`if (window._axFillRunning)`）より後ろになっている（試験は前を要求）。空の点検記録が残る恐れ→**本物の疑い** |
| aix-same-fix-v2691 | 要確認 | `gate_stop_area` の段が消えた（`gate_stop_basic` だけ）。`stall_recover_search` はコメントにしか無い＝その機能は別の形に置き換わった可能性 |
| area-human-flow-v2697 | 要確認 | 「確定してリストへ」を探す候補から `'決定'` が消えた（意図して狭めたか不明） |
| area-and-search-press | 言い回し | `_auditStepP('location', …)` は引用符が `"` になっただけ。`hasModalWard` は代入の形が変わった |
| ad-sort-keeps-conditions-v2686 | 言い回し | 画面に出す文言・コメントが書き換わった（`hover(sortHead`・`hover(adItem` は今も在る） |
| audit-timing | 言い回し | 列の1件ごとの名前の付け方・`_auditOp` の書き方が変わった |
| ai-customer-mode-v2634 | 言い回し | `autoPressPdfs()` が `autoPressPdfs(opt)` に、条件の書き方が変わった |

## 本物の疑い（試験を直さず、振る舞いを確かめる）
1. **leftover-progress-v2825 の F57**: 「駅の客の駅は『外す側』ではないので残りに数えない」が `done:false・stLeft:4` を返す。駅の客で送付後の外しが終わらない恐れ。
2. **audit-not-empty**: `_auditReset` が重複判定より後ろ。空の点検記録（steps=0）が残る恐れ。
3. leftover-progress の残り 3 本: `_scrapeAndSendRealpro` がリアプロの時だけ外しを頼む・送付進捗ありの切り上げでは触らない・次客の switch／fill より前に実行する、の配線が今のコードで見つからない。

## 次の回
残り 112 本は同じ手順（①失敗の言葉と今のコードを並べる ②言い回しだけの変化は試験を直す ③振る舞いが変わった物は竹内さんに聞く ④直したら基準を縮める）。
