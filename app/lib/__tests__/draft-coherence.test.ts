// 実行: npx tsx app/lib/__tests__/draft-coherence.test.ts
// 本文は本番の下書き・実送信の形（名前は伏せた）
import assert from "node:assert/strict";
import { findSeams, seamKinds } from "../draft-coherence";

// 継ぎ目なし（竹内さんの実送信の形）
const ok = "Aさんお世話になっております！！\n\n本日12時お部屋ご案内させて頂きます！\n\n本日は何卒よろしくお願い致します！！";
assert.deepEqual(findSeams(ok), []);
assert.deepEqual(findSeams("かしこまりました😊！！\nもし気になるお部屋ございましたらお気軽にご連絡ください😌！！"), []);
assert.deepEqual(findSeams("🌟レジデンス梅田 301号室\n・家賃 7.5万円\n・2LDK"), []);
// 同じ文の繰り返し（本番の下書き 9/17）
assert.ok(seamKinds("Aさん明日9月17日12時お部屋ご案内させて頂きます！\n\n本日12時お部屋ご案内させて頂きます！").includes("DUP_SENTENCE"));
// 受け止めの重なりは型 DUP ではなく短い文なので見ない（12字未満）
assert.ok(!seamKinds("かしこまりました！！\nかしこまりました😊！！").includes("DUP_SENTENCE"));
// 文頭のかけら
assert.ok(seamKinds("ご内覧ありがとうございました！！\n中に決められましたらご連絡ください！！").includes("FRAGMENT_HEAD"));
assert.ok(seamKinds("かしこまりました！！\nを確認させて頂きます！！").includes("FRAGMENT_HEAD"));
// 行の終わりが続きを待つ
assert.ok(seamKinds("ペット可の条件ですので、\n確認しご連絡させて頂きます！！").includes("DANGLING_TAIL"));
// 締めの重なり
assert.ok(seamKinds("何卒よろしくお願い致します！！\n引き続き何卒よろしくお願い致します！！").includes("DOUBLE_CLOSE"));
// 句読点の崩れ
assert.ok(seamKinds("確認させて頂きますので、。よろしくお願い致します！！").includes("PUNCT_JUNK"));
console.log("draft-coherence: ok");
