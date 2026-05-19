# #43-DOM DOM診断データベース

> Chrome拡張ツール（物件検索サポート）で使用する各サイトのDOM構造を記録する。
> 実装前・バグ修正前に必ず参照する。確認した情報は即座にここに追記する。
> **管理担当**: #43-DOM（調査） / #43-W3（記録）

---

## 📋 使い方

### 新機能実装前
1. このファイルを読んで対象要素のセレクタを確認する
2. 未記録の要素が必要な場合は DevTools コマンドで調査して追記する
3. コードには「確認済みセレクタ」を使う（テキスト一致より CSS セレクタ優先）

### バグ修正時
1. このファイルの該当要素を確認する
2. サイトのUIが変わっている可能性があれば DevTools で再確認する
3. 差異があれば内容を更新する

---

## 🏠 リアプロ（realnetpro.com）

### 確認日: 2026-05-20

### 所在地絞り込みモーダル

| 要素 | セレクタ / テキスト | 確認日 | 備考 |
|---|---|---|---|
| 所在地絞り込みボタン | テキスト `所在地絞り込み＋` / `所在地絞り込み+` | 2026-05-20 | 左メニューのボタン |
| モーダル閉じる | テキスト `×とじる` | 2026-05-20 | モーダル右上 |
| 大阪府ボタン | テキスト `大阪府` | 2026-05-20 | 都道府県一覧内 |
| 市区郡ボタン群 | テキスト完全一致（例:`大阪市平野区`） | 2026-05-20 | グリッド表示・フルネームで一致 |
| 詳細な地域へ進むボタン | **`div.next_step_button2`** (class: `next_step_button2 next_action`) | 2026-05-20 | DevTools調査済・CSSセレクタで確実に取得 |
| 市区郡リセット | テキスト `市区郡リセット` | 2026-05-20 | モーダル内 |

**モーダルフロー（確認済み）**:
```
所在地絞り込み+ クリック
  → 都道府県の設定（大阪府をクリック）
  → 市区郡の設定（例: 大阪市平野区をクリック）
  → 「詳細な地域の設定へ進む」ボタン（div.next_step_button2）をクリック ← ★必須
  → 詳細な地域の設定（例: 喜連西をクリック）
  → ×とじる で閉じる
  → 検索
```

> ⚠️ **重要**: 市区郡を選択しただけでは詳細地域に自動遷移しない。
> `div.next_step_button2` を明示的にクリックする必要がある。

### 沿線・駅絞り込みモーダル

| 要素 | セレクタ / テキスト | 確認日 | 備考 |
|---|---|---|---|
| 沿線・駅絞り込みボタン | `div.click_menu` / `div.one_slide_search_box` でテキスト `沿線・駅絞り込み＋` | 2026-05-17 | CSSクラス優先 |
| 路線ボタン | `label.one_line` テキスト一致 | 2026-05-17 | DevTools調査済 |
| 駅の設定へ進む | テキスト `駅の設定へ進む` / `駅の設定へ進む›` | 2026-05-17 | |
| モーダル確定・閉じる | `div.this_window_close` | 2026-05-17 | DevTools調査済 |
| 駅ボタン | `label` テキスト一致（`selectStationsByName` 関数で処理） | 2026-05-17 | |

### その他フォーム要素

| 要素 | セレクタ | 確認日 | 備考 |
|---|---|---|---|
| 検索ボタン | `div.go_search` / `div.go_search_submit` | 2026-05-17 | DIVが実際のボタン（buttonタグではない） |
| 賃料上限 SELECT | `select[name="rental_cost2"]` | 2026-05-17 | |
| 賃料下限 SELECT | `select[name="rental_cost1"]` | 2026-05-17 | |
| 管理費込みチェック | `input[name="include_common_fee"]` | 2026-05-17 | |
| 徒歩移動手段 | `select[name="transportation_id"]` → value="1" | 2026-05-17 | |
| 徒歩分数 | `input[name="required_time"]` | 2026-05-17 | |
| 築年数 SELECT | `select[name="structured_date"]` | 2026-05-17 | |
| 間取り checkbox | `input[name="room_layout_id[]"]` | 2026-05-17 | |
| 構造 checkbox | `input[name="structured_type[]"]` | 2026-05-17 | |
| ペット相談 checkbox | `input[name="eq_rm[]"][value="113"]` | 2026-05-17 | |
| 都道府県 checkbox | `input[name="pref_code"][value="27"]` | 2026-05-17 | 27=大阪府 |
| 市区郡 checkbox | `input[name="city_code[]"]` | 2026-05-17 | |

---

## 📋 itandi BB（itandibb.com）

### 確認日: 2026-05-18

### フォーム要素

| 要素 | セレクタ / 名前属性 | 確認日 | 備考 |
|---|---|---|---|
| 賃料上限 input | `input[name="rent:lteq"]` | 2026-05-18 | 万円単位で入力 |
| 管理費込みチェック | `input[name="totalRentCheck"]` | 2026-05-18 | |
| 駅徒歩 input | `input[name="station_walk_minutes:lteq"]` | 2026-05-18 | |
| 築年数 input | `input[name="building_age:lteq"]` | 2026-05-18 | |
| 間取り checkbox | `input[name="room_layout:in"][id="レイアウト名"]` | 2026-05-18 | id が 1R/1K/1DK 等 |
| 構造 checkbox | `input[name="structure_type:in"][id="構造名"]` | 2026-05-18 | id が wooden/rc 等 |
| ペット相談 checkbox | `input[name="option_id:all_in"][id="22010"]` | 2026-05-18 | |
| バス・トイレ別 checkbox | `input[name="option_id:all_in"][id="11010"]` | 2026-05-18 | |
| 検索ボタン | テキスト `検索` (button) | 2026-05-18 | clickBtn("検索") で確実 |

### 所在地モーダル（itandi）

| 要素 | テキスト / 処理 | 確認日 | 備考 |
|---|---|---|---|
| 所在地モーダルを開く | ボタンテキスト `所在地で絞り込み` / `エリアで絞り込み` | 2026-05-18 | clickBtn() で完全一致 |
| 近畿タブ | `clickNav("近畿")` | 2026-05-18 | li/button/a/span/label/div[role=button] 完全一致 |
| 大阪府タブ | `clickNav("大阪府")` | 2026-05-18 | LABEL タグが実体（診断済み） |
| 区のチェックボックス | `clickLabel("大阪市北区")` など | 2026-05-18 | label内inputを優先 |
| 確定ボタン | `clickBtn("確定")` | 2026-05-18 | |

### 路線・駅モーダル（itandi）

| 要素 | テキスト / 処理 | 確認日 | 備考 |
|---|---|---|---|
| 路線モーダルを開く | `路線・駅で絞り込み` / `路線で絞り込み` / `沿線・駅で絞り込み` | 2026-05-18 | clickBtn() |
| 近畿タブ | `clickNav("近畿")` | 2026-05-18 | |
| 大阪府タブ | `clickNav("大阪府")` | 2026-05-18 | |
| 路線チェックボックス | `clickLabel(路線名)` | 2026-05-18 | ITANDI_LINE_MAP_FILL の値を使用 |
| 駅チェックボックス | `clickLabel(駅名)` | 2026-05-18 | 「駅」サフィックス除去して検索 |
| 確定ボタン | `clickBtn("確定")` | 2026-05-18 | |

---

## 🔍 レインズ（system.reins.jp）

### 確認日: 2026-05-18

### フォームフィールドインデックス（DevTools全調査完了）

全フィールド数: `querySelectorAll('input[type=text],input[type=number],select')` = **139個固定**

| フィールド | idx | タグ | 備考 |
|---|---|---|---|
| 物件種別1 | 5 | SELECT | "賃貸マンション" をテキスト一致で選択 |
| 沿線名1 | 47 | text input | REINS_LINE_MAP変換後の路線名を入力 |
| 駅名FROM1 | 48 | text input | 完全一致 |
| 駅名TO1 | 49 | text input | 完全一致 |
| 徒歩1 | 50 | number input | |
| 徒歩単位1 | 51 | SELECT | `/分/ｍ` |
| 沿線名2 | 54 | text input | 広げて検索用（将来対応） |
| 賃料上限 | 76 | text input | 万円単位（要実機確認） |

> ⚠️ **遅延レンダリング問題**: フォーム下部が見えているとき idx がズレる
> → `window.scrollTo(0, 0)` + 800ms 待機で全フィールドを確実にレンダリング

---

## 🛠️ DOM調査コマンドテンプレート

### 汎用ボタン検索
```javascript
Array.from(document.querySelectorAll('a,button,div,span')).filter(e=>e.offsetParent&&e.textContent.trim().includes('検索テキスト')).map(e=>e.tagName+'.'+e.className+'#'+e.id+' >> '+e.textContent.trim().slice(0,50)).join('\n')
```

### 特定テキストの完全一致検索
```javascript
Array.from(document.querySelectorAll('*')).filter(e=>e.offsetParent&&e.textContent.trim()==='完全一致テキスト').map(e=>({tag:e.tagName,cls:e.className,id:e.id}))
```

### input/select フィールド一覧取得
```javascript
Array.from(document.querySelectorAll('input[type=text],input[type=number],select')).map((e,i)=>i+': name='+e.name+' id='+e.id+' type='+(e.tagName==='SELECT'?'SELECT':e.type)).join('\n')
```

### モーダル内の全クリッカブル要素
```javascript
Array.from(document.querySelectorAll('a,button,div[onclick],label,input[type=checkbox]')).filter(e=>e.offsetParent).map(e=>e.tagName+'.'+e.className+'#'+e.id+': '+e.textContent.trim().slice(0,30)).join('\n')
```

---

### 町字ボタン（DevTools直接確認済 2026-05-20）

| 要素 | セレクタ | 確認日 | 備考 |
|---|---|---|---|
| 町字ボタン | **`label.one_town`** | 2026-05-20 | DevTools診断で確認。`<label class="one_town"><input type="checkbox" name="town_code[]" title="喜連西" value="27126013">喜連西</label>` |
| 町字チェックボックス | `label.one_town input[type="checkbox"][name="town_code[]"]` | 2026-05-20 | `inp.click()` で checked=true に確認 |

> ✅ `label.one_town` は `display: inline-block`, `visibility: visible`, `offsetParent` あり（position:fixedモーダル内でも正常）

## 📅 更新履歴

| 日付 | 内容 | 担当 |
|---|---|---|
| 2026-05-17 | リアプロ沿線・駅モーダルのDOM構造を初回記録 | #43-DOM |
| 2026-05-18 | itandi BBのフォーム要素・モーダル構造を記録 | #43-DOM |
| 2026-05-18 | レインズのフィールドインデックスを記録（DevTools全調査） | #43-DOM |
| 2026-05-20 | リアプロ所在地モーダルの「詳細な地域の設定へ進む」ボタン確認: `div.next_step_button2.next_action` | #43-DOM（竹内悠馬がDevToolsで直接確認） |
| 2026-05-20 | 町字ボタンのセレクタ確認: `label.one_town > input[type="checkbox"][name="town_code[]"]`。clickDetailArea PASS0として実装 | #43-DOM/#43-W3 |
| 2026-05-20 | 市区郡チェックボックス: `label input[name="city_code[]"]`（label内のinputにchecked状態あり）。div.next_step_button2は常にdisplay:blockで寸法あり→isVisible()で選択状態を判定できない（=根本原因）。clickWardPrecise()でlabel限定・checked前確認クリックに変更 | #43-DOM/#43-W3 |
