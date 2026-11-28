// npx tsx app/lib/__tests__/pii-mask-form-leftovers.test.ts
// 2026-11-28 作業員L（統括役の決め・申込の書類の伏せの穴）: 名前・住所・生年月日は作った値（実在しない）。形は本番の申込フォームと同じ
import assert from "node:assert/strict";
import { maskPII, maskForEmbedding } from "../pii-mask";
import { altPiiSignal } from "../alt-pii-gate";

let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; void name; };
// ── 伏せる ──
t("読点で続く読み仮名も伏せる", () => { const m = maskPII("・氏名、フリガナ 山田花子、ヤマダハナコ ・生年月日 2000年9月中"); assert.ok(!m.includes("ヤマダハナコ") && !m.includes("山田花子"), m); });
t("住所の欄の後ろの7桁の郵便番号と住所", () => { const m = maskPII("・現住所 5200099 滋賀県大津市架空町4-1-928 ・住居年数 8年"); assert.ok(!m.includes("5200099") && !m.includes("架空町"), m); });
t("（住民票記載〒）の形", () => { const m = maskPII("・現住所（住民票記載〒）5770099 大阪府東大阪市架空堂南町3-17 ・住居年数15年"); assert.ok(!m.includes("架空堂南町") && !m.includes("5770099"), m); });
t("欄の名前の無い値の並び（緊急連絡先の行）", () => { const m = maskPII("架空和美 カクウカズミ 1970.6.29 奈良県磯城郡架空町今里240-17 30年 母 架空産業株式会社"); assert.ok(!m.includes("架空和美") && !m.includes("1970.6.29") && !m.includes("架空町"), m); });
t("申込フォームの見出しは残す＝出口の門が当たる", () => { const raw = "【お申込者様記入欄】\n・入居希望日 12月中\n・氏名、フリガナ 架空太郎、カクウタロウ\n・生年月日 1999年2月3日"; const m = maskPII(raw); assert.ok(m.includes("申込者様記入欄"), m); });
t("出口の門: 伏せで変わった見出し（おお客様記入欄）でも、値が残っていれば当たる", () => assert.equal(altPiiSignal("【おお客様記入欄】 ・生年月日 1999年2月3日 ・携帯 090-0000-0000"), "記入済みの申込フォーム"));
t("埋め込みの伏せも同じ", () => { const m = maskForEmbedding("・氏名、フリガナ 山田花子、ヤマダハナコ"); assert.ok(!m.includes("ヤマダハナコ"), m); });
// ── 伏せすぎない（物件・駅・会社・スタッフ） ──
const keep = (s: string, words: string[]) => { const m = maskPII(s); for (const w of words) assert.ok(m.includes(w), `残す: ${w} ／ ${m}`); };
t("物件名と駅名", () => keep("ロジュマンヴェール 4階 1K 価格：4.48万円 交通：阪神本線 / 大物駅 徒歩8分", ["ロジュマンヴェール", "大物駅", "4.48万円"]));
t("物件の所在地", () => keep("物件名：スプランディット難波2 号室名：207（2階部分） 所在地：大阪府大阪市浪速区架空3丁目12番17号 交通：環状線「芦原橋」徒歩3分", ["スプランディット難波2", "大阪府大阪市浪速区架空3丁目12番17号", "芦原橋"]));
t("物件の築年月（生年月日の形に似る）", () => keep("グランハイツ 築年月：2010年9月 所在地：大阪府大阪市北区架空1-2-3", ["2010年9月", "大阪府大阪市北区架空1-2-3"]));
t("会社の住所と郵便番号のハイフンあり（郵便は今まで通り伏せる）", () => { const m = maskPII("株式会社スモラ 大阪府大阪市中央区架空本町1-2-3 本町駅すぐ"); assert.ok(m.includes("大阪府大阪市中央区架空本町1-2-3") && m.includes("本町駅"), m); });
t("スタッフの名前（竹内さん）", () => keep("竹内さんの決定で、内覧は土曜の14時に", ["竹内さんの決定"]));
t("物件番号・家賃の7桁は府県が続かなければ伏せない", () => keep("物件番号 1234567 家賃 1000000円", ["1234567", "1000000円"]));
t("伏せ字の後ろの読点の普通の文は1語だけ", () => { const m = maskPII("お名前：架空太郎、よろしくお願いします"); assert.ok(m.includes("[回答済み・非表示]"), m); });
console.log(`pii-mask-form-leftovers ok ${n}`);
