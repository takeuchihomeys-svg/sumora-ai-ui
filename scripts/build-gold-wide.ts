// scripts/build-gold-wide.ts — 正解の札付けを「竹内さんの文そのもの」から広げた版を作る（AI なし・DB なし・費用0）
//   2026-11-13 作業員10（統括役: 信頼の札付けが狭かった 13→43。他の要素も同じく狭くないかを数え、狭ければ同じ形で広げる）
//   元の版（gold-1113.json）は残す。広げた版は gold-1113-wide.json（役目の並びに足した役目は added に記録・足した理由の語も）
//   広げる線（決まった語・「となります」だけの事実の文は信頼に数えない）:
//     信頼   … こちらの手間・サポートの姿勢・期日・都合・選択肢・正直な弱点・少なさ・会社の具体（compose-phrase-catalog の trustSubsOfText）
//     締め   … 最後の文が 何卒／お気軽に／お待ちしております／よろしくお願い
//     つなぎ … ご案内させて頂きます・ご都合・お日にち（内覧）／お申込・抑え（申込）／御見積書（見積）／お送り頂け・お聞かせ（送ってもらう）
//     頭     … 名前と挨拶の行の後の最初の文が受けの言葉（かしこまりました・はい・ありがとうございます・大丈夫です）
//     潜在   … 数えるだけ（ご安心・心配・不安の語）。文から種類が決まらないので足さない
// 実行: npx tsx scripts/build-gold-wide.ts [--gold=scripts/compose-understanding/gold-1113.json]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SentenceRole } from "../app/lib/takeuchi-anatomy-roles";
import { trustSubsOfText } from "../app/lib/compose-phrase-catalog";
import { openerOfText, loadProbs } from "./lib/compose-gold";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const src = arg("gold", "scripts/compose-understanding/gold-1113.json");
const g = JSON.parse(readFileSync(resolve(ROOT, src), "utf8")) as { note?: string; turns: Array<{ id: string; roles: SentenceRole[] } & Record<string, unknown>> };
const probs = loadProbs(ROOT);
const TRUST: ReadonlySet<SentenceRole> = new Set(["trust", "barrier"]);
const BRIDGE: ReadonlySet<SentenceRole> = new Set(["viewing", "apply", "estimate", "ask_send"]);
const CLOSE: ReadonlySet<SentenceRole> = new Set(["close", "keep"]);
const count: Record<string, { narrow: number; wide: number }> = { 頭: { narrow: 0, wide: 0 }, 信頼: { narrow: 0, wide: 0 }, つなぎ: { narrow: 0, wide: 0 }, 締め: { narrow: 0, wide: 0 }, 潜在: { narrow: 0, wide: 0 } };
const turns = g.turns.map((t) => {
  const text = String(probs.get(t.id)?.staffText ?? "");
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const roles = [...t.roles];
  const added: Array<{ role: SentenceRole; cue: string }> = [];
  const insertBeforeClose = (r: SentenceRole) => { const i = roles.findIndex((x) => CLOSE.has(x)); if (i >= 0) roles.splice(i, 0, r); else roles.push(r); };
  // 頭
  const nH = roles.includes("uke") || roles.includes("greet"); const op = openerOfText(text);
  count.頭.narrow += nH ? 1 : 0;
  if (!nH && op !== "none") { roles.unshift("uke"); added.push({ role: "uke", cue: op }); }
  count.頭.wide += nH || op !== "none" ? 1 : 0;
  // 信頼
  const nT = roles.some((r) => TRUST.has(r)); const subs = trustSubsOfText(text);
  count.信頼.narrow += nT ? 1 : 0;
  if (!nT && subs.length) { insertBeforeClose("trust"); added.push({ role: "trust", cue: subs.join("+") }); }
  count.信頼.wide += nT || subs.length ? 1 : 0;
  // つなぎ
  const nB = roles.some((r) => BRIDGE.has(r));
  const bCue: [SentenceRole, RegExp][] = [["apply", /お申込(?:み)?[^\n]{0,20}(?:抑|押)|お部屋(?:抑|押)え/], ["viewing", /ご案内させて|ご都合|お日にち|ご内覧/], ["estimate", /御見積書|お見積書/], ["ask_send", /お送り頂け|お聞かせ|ご入力/]];
  const bHit = bCue.find(([, re]) => re.test(text)) ?? null;
  count.つなぎ.narrow += nB ? 1 : 0;
  if (!nB && bHit) { insertBeforeClose(bHit[0]); added.push({ role: bHit[0], cue: String(bHit[1].exec(text)?.[0] ?? "") }); }
  count.つなぎ.wide += nB || bHit ? 1 : 0;
  // 締め
  const nC = roles.some((r) => CLOSE.has(r)); const last = lines[lines.length - 1] ?? "";
  const cHit = /何卒|お気軽に|お待ちしております|よろしくお願い/.exec(last)?.[0] ?? null;
  count.締め.narrow += nC ? 1 : 0;
  if (!nC && cHit) { roles.push("close"); added.push({ role: "close", cue: cHit }); }
  count.締め.wide += nC || cHit ? 1 : 0;
  // 潜在（数えるだけ）
  const nL = roles.includes("worry"); const lHit = /ご安心|心配|不安|大丈夫です/.test(text.split(/\n+/).slice(1).join("\n"));
  count.潜在.narrow += nL ? 1 : 0; count.潜在.wide += nL || lHit ? 1 : 0;
  return added.length ? { ...t, roles, added } : t;
});
const out = { note: `${g.note ?? ""} ／ 2026-11-13 作業員10: 竹内さんの文そのものから札付けを広げた版（元は ${src}・足した役目は added）。広げ方は scripts/build-gold-wide.ts の頭の注記`, turns };
const dst = src.replace(/\.json$/, "-wide.json");
writeFileSync(resolve(ROOT, dst), JSON.stringify(out, null, 1));
console.log(`書いた: ${dst}（${turns.length}番・足した番 ${turns.filter((t) => "added" in t).length}）`);
console.log("要素｜竹内さんにある番 狭い→広い");
for (const [k, v] of Object.entries(count)) console.log(`${k}｜${v.narrow}→${v.wide}${k === "潜在" ? "（数えるだけ・足していない）" : ""}`);
