/** 手順書の時間・待ち・外し方の決まりを洗い出す（読むだけ）。2026-11-26 */
import { AUTO_RULES } from "../app/lib/auto-procedure-rules";

const rules = AUTO_RULES as unknown as { id: string; scene?: string; since?: string; text: string; marker?: string; file?: string }[];
console.log("決まり", rules.length, "件");

// ① 1つずつ外す・リセットの言及（古い前提が残っていないか）
const oneByOne = rules.filter((r) => /1つずつ外|一つずつ外|1つずつ|外し/.test(r.text));
console.log("\n■ 『外し』に触れる決まり", oneByOne.length, "件のうち、リセット優先（reset_replaces_clear など）の断りが無いもの:");
oneByOne.filter((r) => !/reset_replaces_clear|リセット(が|を|で)[^。]{0,30}(成功|押)|reset_retry_insurance|リセットが押せない|リセットで空/.test(r.text)).forEach((r) => console.log(`  ${r.id} (since ${r.since}) scene=${r.scene}`));

// ② 時間の数字（秒・分）を持つ決まり
console.log("\n■ 数字つきの待ち（秒/分）を持つ決まり:");
rules.forEach((r) => {
  const m = r.text.match(/\d+(?:[〜~\-]\d+)?\s*(?:秒|分)/g);
  if (m && /待|間|あけ|まで/.test(r.text)) console.log(`  ${r.id.padEnd(34)} ${Array.from(new Set(m)).slice(0, 8).join(" ")}`);
});

// ③ 「1秒」「1000ms」など古い短い待ちの前提
console.log("\n■ 古い短い待ち（1秒/1000ms/2秒/3秒 …）を含む決まり:");
rules.filter((r) => /(?<![\d〜~\-])[1-3]\s*秒|1000ms|[1-3]秒以上/.test(r.text)).forEach((r) => {
  const m = r.text.match(/.{0,24}(?<![\d〜~\-])[1-3]\s*秒.{0,24}|.{0,24}1000ms.{0,20}/);
  console.log(`  ${r.id} (${r.since}) …${m ? m[0] : ""}…`);
});

// ④ 同じ種類の決まりが複数（重複）: 先頭語が同じ id
console.log("\n■ 重複しそうな id の組（共通語）:");
const stems = new Map<string, string[]>();
rules.forEach((r) => { const k = r.id.split("_").slice(0, 2).join("_"); stems.set(k, [...(stems.get(k) || []), r.id]); });
[...stems.entries()].filter(([, v]) => v.length >= 3).forEach(([k, v]) => console.log(`  ${k}: ${v.join(", ")}`));

// ⑤ シーン別の件数
const sc = new Map<string, number>();
rules.forEach((r) => sc.set(String(r.scene), (sc.get(String(r.scene)) || 0) + 1));
console.log("\n■ シーン別:", [...sc.entries()].map(([k, v]) => `${k}=${v}`).join(" "));
const lens = rules.map((r) => r.text.length).sort((a, b) => b - a);
console.log("■ 文字数: 合計", lens.reduce((a, b) => a + b, 0), "最長", lens[0], "上位5", lens.slice(0, 5).join(","));
