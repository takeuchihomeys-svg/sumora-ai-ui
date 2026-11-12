// app/lib/__tests__/db-json-sanitize.test.ts
// 2026-11-13 作業員8b: 会話 c40e1625 の判断が「Empty or invalid json」で保存されなかった（11/12 だけで 138回）。
//   実物の形: 22字の最後が絵文字のお客様の発言を、判断の欄が .slice(0, 22) 等で切ると片割れが残る。
// 実行: npx tsx app/lib/__tests__/db-json-sanitize.test.ts
import { sanitizeJsonForDb } from "../db-json-sanitize";

let fail = 0, pass = 0;
function t(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// 実物の形（本文は伏せた作りの文・21字＋絵文字＝UTF-16 で 23）
const msg = "あいうえおかきくけこさしすせそたちつてとな😊";
const cut = msg.slice(0, 22); // 絵文字の上の片割れだけ残る
t("前提: slice で片割れができる", cut.length === 22 && /[\uD800-\uDBFF]$/.test(cut));
t("前提: そのままでは JSON に片割れのエスケープが出る（PostgREST が断る形）", /\\ud83d/i.test(JSON.stringify({ x: cut })));

const meta = { action: "物件確認した", note: "x", analyzed_msg_ts: "2026-11-11T11:45:52.286Z", reading: { last_customer: cut, asks: [{ q: cut, route: "reply" }] }, score: NaN, ok: msg };
const r = sanitizeJsonForDb(meta);
t("直した", r.fixed && r.fix.surrogates === 2 && r.fix.nonFinite === 1, JSON.stringify(r.fix));
t("どの欄かが分かる", r.fix.paths.join(",") === "reading.last_customer,reading.asks[0].q,score", r.fix.paths.join(","));
t("片割れだけ取り除き、前の文字は残る", (r.value.reading.last_customer as string) === msg.slice(0, 21));
t("正しい絵文字は1文字も変えない", r.value.ok === msg);
t("NaN は null", r.value.score === null);
t("直した後は JSON に片割れのエスケープが無い", !/\\ud[89a-f]/i.test(JSON.stringify(r.value)));
t("元の値は変えない（呼び出し元の meta を壊さない）", meta.reading.last_customer === cut);

const clean = { a: "ふつうの文😊", b: [1, 2, { c: "x" }], d: null, e: true };
const r2 = sanitizeJsonForDb(clean);
t("直す物が無ければ同じ参照", !r2.fixed && r2.value === clean);
const r3 = sanitizeJsonForDb({ s: "a\u0000b", low: "\uDE0Aだけ" });
t("NUL と下の片割れも取る", r3.fixed && r3.value.s === "ab" && r3.value.low === "だけ" && r3.fix.nul === 1 && r3.fix.surrogates === 1, JSON.stringify(r3));

// 配線: brain-core の判断の書き込みが清めた値を両方の列に書く
{
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "brain-core.ts"), "utf8") as string;
  const i = src.indexOf("const dbSafe = sanitizeJsonForDb(metaToWrite)");
  const seg = src.slice(i, i + 1500);
  t("配線: suggested_aix_meta と last_brain_meta の両方が dbSafe.value", i > 0 && seg.includes("suggested_aix_meta: dbSafe.value") && seg.includes("last_brain_meta: dbSafe.value"));
}
console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
