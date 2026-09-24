// 2026-09-24 竹内「画像で分析ボタン」— 純関数のテスト
// 実行: npx tsx app/lib/__tests__/pickup-image-analysis.test.ts
import { parseAnalysis, pickBest, buildWantsText, buildAnalysisPrompt } from "../pickup-image-analysis";
import { cropRectForSheet } from "../pdf-trim";
import { pickAnalysisImageUrl, needsTrimBeforeAnalysis } from "../pickup-image-url";
let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}
{
  const a = parseAnalysis('```json\n{"water":"バス・トイレ別","kitchen":"壁付け","layout":"隣り合う","storage":"CL","match":"62","good":["バストイレ別"],"concern":["WICなし"]}\n```');
  t("★ コードブロックの JSON を読む・match の文字列を数に", !!a && a.match === 62 && a.kitchen === "壁付け" && a.concern[0] === "WICなし", a);
  t("★ match が範囲外なら 0〜100 に丸める", parseAnalysis('{"water":"a","match":140}')?.match === 100);
  t("★ match が null なら null（希望なし）", parseAnalysis('{"water":"a","match":null}')?.match === null);
  t("★ 何も読めていない返事は失敗（null）", parseAnalysis('{"water":"","kitchen":"","layout":"","storage":"","match":80}') === null);
  t("★ 壊れた返事は null", parseAnalysis("読めませんでした") === null);
}
{
  const rows = [
    { id: 1, rank: 1, analysis: { water: "a", kitchen: "", layout: "", storage: "", match: 60, good: [], concern: [], checks: [] } },
    { id: 2, rank: 2, analysis: { water: "a", kitchen: "", layout: "", storage: "", match: 80, good: [], concern: [], checks: [] } },
    { id: 3, rank: 3, analysis: { water: "a", kitchen: "", layout: "", storage: "", match: 80, good: [], concern: [], checks: [] } },
    { id: 4, rank: 4, analysis: null },
  ];
  t("★ 一番合う＝点が最大・同点は順位が上", pickBest(rows)?.id === 2);
  t("★ 点が1件も無ければ null", pickBest([{ id: 1, rank: 1, analysis: null }]) === null);
  // YUMA: 全件が必須 NG で 20 点に並んだ時、順位でなく上限前の点で選ぶ（一番合わない物件が「一番」にならない）
  const tie = [
    { id: 1, rank: 1, analysis: { water: "a", kitchen: "", layout: "", storage: "", match: 20, match_raw: 30, good: [], concern: [], checks: [] } },
    { id: 3, rank: 3, analysis: { water: "a", kitchen: "", layout: "", storage: "", match: 20, match_raw: 70, good: [], concern: [], checks: [] } },
  ];
  t("★ 同点（必須 NG で 20 点）は上限前の点で選ぶ", pickBest(tie)?.id === 3);
}
{
  const w = buildWantsText({ customer_name: "山田太郎", phone: "090", floor_plan: "1LDK", preferences: "独立洗面台", ng_points: "1階NG" }, "WIC が欲しい");
  t("★ 希望の文は条件の欄だけ（名前・電話は入れない）", !w.includes("山田") && !w.includes("090") && w.includes("独立洗面台") && w.includes("1階NG") && w.includes("WIC が欲しい"), w);
  t("★ 希望が空なら「（特になし）」", buildAnalysisPrompt("").includes("（特になし）"));
  t("★ 対面を推測しない指示がある", buildAnalysisPrompt("").includes("推測で「対面」にしない"));
}
{
  t("★ トリミングは既定で100%（1ページ目は帯替え済み）", JSON.stringify(cropRectForSheet(1548, 1093)) === JSON.stringify({ x: 0, y: 0, width: 1548, height: 1093 }));
  t("★ 86% を渡せば従来の形", cropRectForSheet(1548, 1093, 0.86).height === 940);
}
{
  // 2026-09-24 竹内「プロンプトキャッシュされているのか（DeepSeek）」: 前置きキャッシュは先頭が同じ間だけ効く。
  //   固定の指示（約640トークン）が希望より前にあり、希望が変わっても同じであること（画像を先頭にすると命中 0 だった）
  const a = buildAnalysisPrompt([{ id: "W1", source: "条件", text: "WIC希望", topics: ["storage"], ng: false, must: false }]);
  const b = buildAnalysisPrompt([{ id: "W1", source: "会話", text: "ペット可がいい", topics: ["pet"], ng: false, must: true }]);
  const head = "お客様の希望（【出どころ・NG・必須】）:";
  const fixedA = a.slice(0, a.indexOf(head)), fixedB = b.slice(0, b.indexOf(head));
  t("★ キャッシュ: 希望が違っても固定の指示（先頭）は1文字も変わらない", fixedA.length > 800 && fixedA === fixedB, { la: fixedA.length, lb: fixedB.length });
  t("★ キャッシュ: 固定の指示に日時・数字の時刻が入っていない", !/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/.test(fixedA));
  t("★ キャッシュ: 希望は固定の指示より後ろ", a.indexOf("WIC希望") > a.indexOf(head));
}
{
  // 2026-09-24 竹内「文字が反映されていないバグ」: 画像で分析には文字のある画像だけを渡す
  t("★ 画像: トリミングがあればそれ", pickAnalysisImageUrl({ trim_image_url: "T", page_image_url: "P", pdf_has_text: false }) === "T");
  t("★ 画像: 文字層が取れた回の page_image_url は使う（直した後の記録）", pickAnalysisImageUrl({ trim_image_url: null, page_image_url: "P", pdf_has_text: true }) === "P");
  t("★ 画像: 文字層が無い回の page_image_url は使わない（直す前の文字抜け）→ 先にトリミング", pickAnalysisImageUrl({ trim_image_url: null, page_image_url: "P", pdf_has_text: false }) === null && needsTrimBeforeAnalysis({ page_image_url: "P", pdf_has_text: false }));
}
console.log(`\n合計: ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
