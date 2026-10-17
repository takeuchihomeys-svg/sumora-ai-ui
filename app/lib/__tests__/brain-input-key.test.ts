// app/lib/__tests__/brain-input-key.test.ts — 同じ入力の鍵で2回ブレインを回さない（2026-10-18）
// 実行: npx tsx app/lib/__tests__/brain-input-key.test.ts
import { brainInputKeyOf, decideInputKeyReuse } from "../brain-input-key";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info ?? ""); } };

const base = [
  { sender: "staff", text: "物件お送りします！！", created_at: "2026-10-18T01:00:00Z" },
  { sender: "customer", text: "ありがとうございます", created_at: "2026-10-18T01:05:00Z" },
  { sender: "customer", text: "[画像]", created_at: "2026-10-18T01:05:10Z" },
];
const k0 = brainInputKeyOf(base, "2026-10-18T00:50:00Z");
t("並びが逆でも同じ鍵", brainInputKeyOf([...base].reverse(), "2026-10-18T00:50:00Z") === k0);
t("お客様の新しい発言で鍵が変わる", brainInputKeyOf([...base, { sender: "customer", text: "あと1つ", created_at: "2026-10-18T01:06:00Z" }], "2026-10-18T00:50:00Z") !== k0);
t("スタッフの送信で鍵が変わる", brainInputKeyOf([...base, { sender: "staff", text: "確認します", created_at: "2026-10-18T01:06:00Z" }], "2026-10-18T00:50:00Z") !== k0);
t("AIX の押下で鍵が変わる", brainInputKeyOf(base, "2026-10-18T01:06:00Z") !== k0);
t("画像の読み取りで文が書き換わると鍵が変わる",
  brainInputKeyOf(base.map((m) => (m.text === "[画像]" ? { ...m, text: "[画像] 【物件の資料】 〇〇マンション 3階" } : m)), "2026-10-18T00:50:00Z") !== k0);
t("前の番の文（スタッフの送信より前）は指紋に入らない",
  brainInputKeyOf([{ sender: "customer", text: "古い発言（書き換え）", created_at: "2026-10-18T00:59:00Z" }, ...base], "2026-10-18T00:50:00Z")
    === brainInputKeyOf([{ sender: "customer", text: "古い発言", created_at: "2026-10-18T00:59:00Z" }, ...base], "2026-10-18T00:50:00Z"));
t("読めない時刻は無視", brainInputKeyOf([...base, { sender: "customer", text: "x", created_at: "bad" }], "2026-10-18T00:50:00Z").startsWith(k0.slice(0, 30)));

const now = Date.parse("2026-10-18T02:00:00Z"); // JST 11:00
const r = (o: Partial<Parameters<typeof decideInputKeyReuse>[0]>) => decideInputKeyReuse({ key: k0, prevKey: k0, prevSource: "brain_fresh", prevAnalyzedAt: "2026-10-18T01:10:00Z", forced: false, nowMs: now, env: {}, ...o });
t("同じ鍵・同じ日・6時間以内は使い回す", r({}).reuse);
t("鍵が違えば回す", r({ prevKey: "c:x" }).reason === "key_changed");
t("前の鍵が無い（入れる前の分析）は回す", r({ prevKey: null }).reason === "no_prev_key");
t("forced（宣言直後・画像の読み取り）は回す", r({ forced: true }).reason === "forced");
t("前回が cached は回す", r({ prevSource: "cached" }).reason === "prev_not_reusable");
t("前回が aix_patch は回す", r({ prevSource: "aix_patch" }).reason === "prev_not_reusable");
t("6時間を超えたら回す", r({ prevAnalyzedAt: "2026-10-17T19:59:00Z" }).reason === "too_old");
t("日付（JST）をまたいだら回す", r({ prevAnalyzedAt: "2026-10-17T14:50:00Z", nowMs: Date.parse("2026-10-17T16:00:00Z") }).reason === "day_changed");
t("BRAIN_INPUT_KEY_REUSE=off は回す", r({ env: { BRAIN_INPUT_KEY_REUSE: "off" } }).reason === "switch_off");
t("前回の時刻が読めなければ回す", r({ prevAnalyzedAt: null }).reason === "no_prev_time");
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
