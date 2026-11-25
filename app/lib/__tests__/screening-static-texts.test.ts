// 2026-11-26 作業員L: 決まりの文（欄の説明）だけを、一字一句そのままの時に網の前に外す。網そのもの（「出所」を含む）は緩めない
import assert from "node:assert/strict";
import { screeningSensitiveSignal } from "../screening-sensitive";
import { NOW_VS_LATER_FIELD } from "../brain-now-later";
import { ASK_PARTS_FIELD } from "../ask-parts";
import { TURN_READ_BRAIN_FIELD } from "../turn-read";
import { stripScreeningStaticTexts, SCREENING_STATIC_TEXTS } from "../screening-static-texts";

// 網は今まで通り当たる（「の出所」で書かれた本当の事情も）
for (const x of ["昨年の出所", "刑務所の出所の後", "去年出所しました", "前科があります", "服役していました"])
  assert.equal(screeningSensitiveSignal(x)?.category, "前科", x);
// 決まりの文は、そのままの形なら外れる
assert.equal(SCREENING_STATIC_TEXTS.length, 3);
assert.equal(screeningSensitiveSignal(stripScreeningStaticTexts(`${TURN_READ_BRAIN_FIELD}\n${NOW_VS_LATER_FIELD}\n${ASK_PARTS_FIELD}`)), null);
// 決まりの文と一緒にお客様の事情があれば当たる
assert.equal(screeningSensitiveSignal(stripScreeningStaticTexts(`${NOW_VS_LATER_FIELD}\nお客様: 昨年の出所でして`))?.category, "前科");
assert.equal(screeningSensitiveSignal(stripScreeningStaticTexts(`${TURN_READ_BRAIN_FIELD}\nお客様: 実は夜職で働いています`))?.category, "職業（夜の仕事・無職 等）");
// 一字でも違えば外れない（お客様の文は消えない）
assert.ok(screeningSensitiveSignal(stripScreeningStaticTexts(NOW_VS_LATER_FIELD.slice(1))) !== null);
console.log("screening-static-texts ok 10");
