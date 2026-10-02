// app/lib/outgoing-residue.ts
// お客様に送る文に「機械の名残」（JSON・コード・テストの印）が残っていないかを見る最後の網（純関数・DB も fetch も持たない）。
//
// 2026-10-02 竹内さん（YUMA の LINE を読んで）:
//   ③ AIX【内覧調整】が「…ご案内可能です😊！！","closing":"YUMAさんご都合よろしいお日にち御座いますでしょうか😌！！"}」のまま届いた
//      →「監視が防げる部分」。部品の読み取り（aix-json-parts.ts・⑫ 1e4c7500）は直したが、どの生成の道でも同じ形が出うるので、
//      **送る直前（/api/send-line-message）と LINE の見張り（line-watch）の2か所**で同じ関数で止める。
//   ④「【テスト送信・絵文字の重なりの点検】YUMAさん、お部屋お送り頂き…」がテストの道具から会話に入った →「テスト送信入っている。紛れないように」。
//      テストの印（【テスト送信…】【テスト】・（テスト）の見出し・「お客様には送っていません」）も送る前に止める。
//
// 線（scripts/audit-outgoing-residue.ts・本番のスタッフの送信 365日 8,441通＝人の手打ち 6,029・AIX 2,412 に当てて誤検出 0 を確かめた形だけ）:
//   ・JSON の鍵の並び   「","closing":"」「{"message":"」「"appeal": "」＝ ASCII の二重引用符＋英字の鍵＋コロン
//   ・JSON の閉じ        行末の「"}」「"]}」（人の文は「」で引用し ASCII の " で閉じない）
//   ・エスケープの名残   「\n」「\"」「あ」（バックスラッシュの後に n / " / u＋16進）
//   ・コードの囲い       「```」
//   ・中身の無い値       「undefined」「[object Object]」「NaN円」
//   ・テストの印         「【テスト送信」「【テスト】」「お客様には送っていません」「（書式の点検」
//   ⚠ 英字の鍵の無い「"」だけ、「{」「}」だけ（顔文字「(*´꒳`*)」「{笑}」）は人の文にもあるので見ない。
//
// 止めた時に直さない（本文の書き換えはしない）: 名残は「どこまでが本文か」が決められない（部品の途中で切れている）ので、
//   送らずにスタッフへ返す（送信 API は 422・見張りは記録）。直すのは生成の側（aix-json-parts 等）。

export type ResidueKind = "json_key" | "json_close" | "escape" | "code_fence" | "empty_value" | "test_marker";

export type ResidueHit = { kind: ResidueKind; label: string; match: string };

const RULES: Array<{ kind: ResidueKind; label: string; re: RegExp }> = [
  // 「","closing":"」「{"message":"」「"appeal": "」— ASCII の " ＋ 英字の鍵 ＋ " ＋ コロン
  { kind: "json_key", label: "JSON の鍵（\"key\":）", re: /"[A-Za-z_][A-Za-z0-9_]{0,40}"\s*:\s*(?:"|\[|\{|-?\d|true|false|null)/ },
  // 行末・文末の「"}」「"]}」「"]」（JSON の閉じ）
  { kind: "json_close", label: "JSON の閉じ（\"} で終わる）", re: /"\s*\]?\s*\}\s*(?:$|\n)/ },
  // 先頭が「{"」（JSON の開き）
  { kind: "json_close", label: "JSON の開き（{\" で始まる）", re: /(?:^|\n)\s*\{\s*"/ },
  // エスケープの名残（\n・\"・あ）。全角の ￥ や「\50,000」（円記号の半角）は当てない＝後ろが n・"・u＋16進の時だけ
  { kind: "escape", label: "エスケープの名残（\\n・\\\"・\\u）", re: /\\(?:n(?![0-9０-９,，])|"|u[0-9a-fA-F]{4})/ },
  { kind: "code_fence", label: "コードの囲い（```）", re: /```/ },
  { kind: "empty_value", label: "中身の無い値（undefined・[object Object]・NaN）", re: /\bundefined\b|\[object Object\]|\bNaN(?:円|件|%|万)?(?![A-Za-z])/ },
  // テストの印（2026-10-02 ④）。本番のスタッフの送信 365日で 0通
  { kind: "test_marker", label: "テストの印（【テスト送信】等）", re: /【\s*テスト(?:送信)?[^】]{0,30}】|［\s*テスト(?:送信)?[^］]{0,30}］|\[\s*テスト(?:送信)?[^\]]{0,30}\]|お客様には送っていません|（\s*書式の点検|テスト送信です/ },
];

/** 送る文の機械の名残（JSON・コード・テストの印）を全部返す（無ければ空） */
export function detectOutgoingResidue(text: string | null | undefined): ResidueHit[] {
  const s = String(text ?? "");
  if (!s.trim()) return [];
  const hits: ResidueHit[] = [];
  for (const r of RULES) {
    const m = s.match(r.re);
    if (m) hits.push({ kind: r.kind, label: r.label, match: m[0].slice(0, 40) });
  }
  return hits;
}

/** 送ってはいけない名残があるか（送信 API・見張りの判定） */
export function hasOutgoingResidue(text: string | null | undefined): boolean {
  return detectOutgoingResidue(text).length > 0;
}

/** スタッフに見せる日本語の理由（1行） */
export function describeOutgoingResidue(hits: ResidueHit[]): string {
  if (!hits.length) return "";
  return `送る文に機械の名残があります（${hits.map((h) => `${h.label}「${h.match}」`).join("・")}）。文を直してから送ってください`;
}
