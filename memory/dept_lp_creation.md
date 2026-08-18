# LP/HP制作部署 倉庫

> 管理: #LP-W（LP制作ワーカー）
> 最終更新: 2026-08-19

---

## 部署概要

会社（株式会社ホームズ）のランディングページ・ホームページを制作・管理する部署。
主な目的はLINE友だち追加・問い合わせ獲得。

---

## 公開中のLP一覧

| ページ | ファイル | URL | 目的 |
|--------|----------|-----|------|
| イエヤス LP | `public/iyeyasu.html` | `/iyeyasu.html` | LINE友だち追加（賃貸仲介） |

---

## デザインシステム

### カラーパレット（イエヤス）

| 変数名 | 値 | 用途 |
|--------|----|------|
| `--line-green` | `#06C755` | LINEブランドグリーン・CTA背景 |
| `--line-green-dark` | `#05aa47` | LINEボタンホバー |
| `--line-green-deeper` | `#048a39` | グラデーション終端 |
| `--forest` | `#1b6e2e` | ヘッダー・武将グリーン |
| `--tangerine` | `#ff6b35` | アクセント橙（バッジ） |
| `--sun` | `#f5c842` | 黄色アクセント（見出し強調） |

### フォント
- 本文: `'Hiragino Maru Gothic ProN'`（丸ゴシック・ポップ感）
- ヒーロー: `-apple-system, 'Hiragino Sans'`（クリーン）

### LINEボタン規格
```css
border-radius: 50px;         /* 完全丸 */
font-size: 18〜20px;
font-weight: 700〜900;
background: #05aa47;
width: 100%;
padding: 16〜20px 24px;
box-shadow: 0 4px 16px rgba(0,0,0,0.22);
```

### レイアウト
- **スマホ縦型**: `max-width: 480px; margin: 0 auto;`
- **固定フッターバー**: LINEボタン常時表示（`position: fixed; bottom: 0`）
- **scrollreveal**: `.r` クラス + IntersectionObserver

---

## コピーライティングパターン

### ヒーロー見出し型
```
[サービス名]で[ベネフィット]！
気になっている[対象]の[痛み点]が[解決法]
```
例: 「イエヤスでお得にお部屋探し」「気になっているお部屋の初期費用が簡単割引！」

### CTAボタン文言
- 「今すぐ[サービス名]でお部屋探し！」
- 「LINE友だち追加」
- 「友だち追加して無料相談する」
- 「今すぐLINEで相談する（無料）」

### マイクロコピー（ボタン下）
- 「登録無料 · 来店不要 · 24時間受付」

### 避けるべき表現
- AI的な説明文（「〜を実現します」「革新的な〜」）
- 費用内訳テーブル（複雑すぎる）
- 絵文字の多用

---

## ヒーローセクション パターン集

### パターンA: LINE広告風（現行・イエヤス）
- 緑グラデーション背景
- 左: スマホモックアップ（LINEチャット表示）
- 右: 白カード（割引特典チェックリスト）
- 下: 大型LINEボタン
- 参考: LINEポケットマネー広告

### パターンB: キャラクター中心（旧・イエヤス）
- 緑グラデーション背景
- 中央: SVGキャラクター（武将）
- 中央: LINEボタン
- テキスト: 上部キャッチコピー

### パターンC: スモラ風クリーン（参考）
- 白ベース
- SVGラインアイコン
- 節約シミュレーションカード
- 参考: sumora.net

---

## キャラクター資産

### イエヤス武将キャラ（SVG）
- ファイル内の `<svg viewBox="0 0 200 220">` ブロック
- 緑甲冑・家紋前立て・手に小さな家
- 色: `#1b6e2e`（鎧）、`#f9c090`（肌）、`#f5c842`（金装飾）
- `public/iyeyasu.html` 内にインライン定義

---

## 制作フロー

### 新LP制作
1. 参考サイトURLをユーザーから収集
2. Fable5（Workflow）で Research → Build の2フェーズ実行
   - Phase 1: 参考LP調査（WebFetch）
   - Phase 2: HTML生成（スキーマ付きstructured output）
3. 出力HTMLを `public/[name].html` に保存
4. Artifactでプレビュー確認
5. `git push` → Vercel自動デプロイ

### Fable5 Workflowスクリプト雛形
```javascript
export const meta = {
  name: 'lp-build',
  description: 'LP制作',
  phases: [
    { title: 'Research', detail: '参考LP調査' },
    { title: 'Build', detail: 'HTML生成' },
  ],
}
phase('Research')
const research = await agent('参考LP分析...', { schema: RESEARCH_SCHEMA })
phase('Build')
const result = await agent('HTML生成...', { schema: { type:'object', required:['html'], properties:{ html:{type:'string'} } } })
return result
```

### デプロイ先
- **Vercel**: `sumora-ai-ui.vercel.app/[filename].html`（public/に置くだけ）
- **独自ドメイン**: `ieyas-chintai.com`（NS: ns1/ns2.vercel-dns.com）

---

## ドメイン管理

| ドメイン | 用途 | 取得先 | 有効期限 |
|----------|------|--------|----------|
| `ieyas-chintai.com` | イエヤスLP | バリュードメイン(GMO) | 2027-08-18 |

Vercelへの紐付け: `vercel domains add [domain] sumora-ai-ui`

---

## 黄金ルール

1. **LINEボタンは最低3箇所**（ヒーロー・中盤・固定フッター）
2. **スマホ縦型** `max-width:480px` 必須
3. **外部CDN禁止**（Artifact CSP対応・インラインのみ）
4. **`git push`後に必ずArtifactも更新**（同URL再デプロイ）
5. **変更後はこのファイル（dept_lp_creation.md）を即更新**

---

## 実装履歴

| 日付 | 内容 | コミット |
|------|------|---------|
| 2026-08-16 | イエヤスLP初版（スモラ風クリーン） | `358da1d` |
| 2026-08-19 | 第3版: ポップ・スマホ縦型・武将キャラ | `9bbab38` |
| 2026-08-19 | 第4版: LINE広告風ヒーロー（スマホモックアップ） | `2ffbbd2` |

---

## 次回セッション引き継ぎ

- [ ] `ieyas-chintai.com` のNS変更確認（バリュードメイン側）
- [ ] LP効果測定の仕組みを検討（LINE登録数トラッキング等）
- [ ] 次のLP案件があれば本倉庫に追記
