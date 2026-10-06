// scripts/audit-draft-gap-types.ts — 2巡目: audit-draft-gap-by-scene.ts の書き出し（per）を「誤差の型」で数える（読むだけ）
// 実行: npx tsx scripts/audit-draft-gap-types.ts <gap.json> [--scene=<鍵の名前>]
import { readFileSync } from "node:fs";
import { editCore } from "../app/lib/edit-diff";
import { resolveReplyScene, REPLY_SCENE_JA } from "../app/lib/reply-scene";

type P = { id: string; at: string; tpo: string; act: string; amount: string; sim: number; deleted: string[]; added: string[]; rephrased: Array<[string, string]>; cust: string; draft: string; sent: string; closer: string | null; sub: string[] | null };
const j = JSON.parse(readFileSync(process.argv[2], "utf8")) as { per: P[] };
const N = (s: string) => s.normalize("NFKC");

const CHECK = /確認(?:させて|致し|いたし|して|し(?:ご連絡|次第|て)|出来次第)|お調べ|問い合わせ|問合せ/;
const VAGUE_CHECK = /^(?:[^。！!]{0,10})?(?:確認出来次第|確認しご連絡|確認次第)/;
const GREET = /お世話になっております|はじめまして/;
const NAME_LINE = /^[^。！!\s]{1,14}(?:さん|様)[、,]?$/;
const CLOSE = /よろしくお願い|何卒|お手隙|ご査収|ご確認(?:下さい|ください)|お気軽に|お申し付け/;
const EXTRA = /見つかるまで|全力で|サポートさせて|尽力|最善の|ご安心|安心です|楽しみ|嬉しく思/;
const APPEAL = /内覧|ご案内|お申込|申込|抑え|押さえ/;
const RESIDUE = /\[AIX|【AIX|finalCheck|\*\*|FINAL_CHECK|現状の会話/;

/** 場面（お客様の最後の発言から・機械で）— 1つの判定に寄せる前の物差し */
export function sceneOfOld(cust: string): string {
  const c = N(cust).trim();
  if (/^\s*\[画像\]|https?:\/\/|suumo|homes\.co|物件名[:：]/i.test(c)) return "物件を送ってきた";
  if (/初期費用|見積|いくら|総額|費用/.test(c)) return "費用・見積の依頼";
  if (/内覧|内見|見学|何時|日程|空いて(?:る|ます)日|[0-9]+日|土曜|日曜|平日/.test(c)) return "内覧・日程";
  if (/申込|申し込み|審査|契約|書類|保証/.test(c)) return "申込・審査";
  if (/[?？]|ですか|ますか|でしょうか|かな|ますかね|可能/.test(c)) return "質問";
  if (/エリア|家賃|万|間取|駅|徒歩|1K|1LDK|2LDK|1DK|ペット|築|条件|希望/i.test(c)) return "条件・希望";
  if (/検討|考え|相談|迷|また連絡|後ほど/.test(c)) return "検討中";
  if (c.length <= 30 && /ありがと|よろしく|了解|わかりました|分かりました|承知|はい|お願いします|助かり|大丈夫/.test(c)) return "短いお礼・了承";
  return "その他";
}

const sceneOf = (c: string) => REPLY_SCENE_JA[resolveReplyScene({ customerText: c }).scene];
const types: Record<string, (p: P) => boolean> = {
  "そのまま（none/tiny）": (p) => p.amount === "none" || p.amount === "tiny",
  "書き直し（sim<0.3＝場面・中身が違う）": (p) => p.sim < 0.3,
  "確認の約束に逃げた（AI が確認の約束・人は確認の約束なし）": (p) => CHECK.test(N(p.draft)) && !CHECK.test(N(p.sent)),
  "対象のない約束（確認出来次第ご連絡…を人が消した）": (p) => p.deleted.some((x) => VAGUE_CHECK.test(N(x).trim())),
  "人が挨拶を足した": (p) => !GREET.test(p.draft) && GREET.test(p.sent),
  "人が挨拶を消した": (p) => GREET.test(p.draft) && !GREET.test(p.sent),
  "人が呼びかけの行を足した": (p) => p.added.some((x) => NAME_LINE.test(x.trim())) && !p.draft.split(/\n/).some((x) => NAME_LINE.test(x.trim())),
  "人が締めを足した": (p) => !CLOSE.test(p.draft) && CLOSE.test(p.sent),
  "人が締めを消した": (p) => CLOSE.test(p.draft) && !CLOSE.test(p.sent),
  "AI の余計な一文（伴走・安心・嬉しい）を人が消した": (p) => p.deleted.some((x) => EXTRA.test(x)),
  "AI の訴求（内覧・申込）を人が消した": (p) => p.deleted.some((x) => APPEAL.test(x)) && !APPEAL.test(p.sent),
  "人が訴求（内覧・申込）を足した": (p) => !APPEAL.test(p.draft) && APPEAL.test(p.sent),
  "作業メモ・名残": (p) => RESIDUE.test(p.draft),
  "人の方が3割以上短い": (p) => editCore(p.sent).length < editCore(p.draft).length * 0.7,
  "人の方が3割以上長い": (p) => editCore(p.sent).length > editCore(p.draft).length * 1.3,
};
const sceneArg = process.argv.find((a) => a.startsWith("--scene="))?.slice(8);
const rows = j.per.filter((p) => !sceneArg || sceneOf(p.cust) === sceneArg);
const scenes = new Map<string, P[]>();
for (const p of rows) { const k = sceneOf(p.cust); scenes.set(k, [...(scenes.get(k) ?? []), p]); }
const pct = (a: number, b: number) => `${b ? Math.round((a / b) * 100) : 0}%`;
const cols = [...scenes.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`全 ${rows.length} 番`);
console.log(["型".padEnd(36), "全体", ...cols.map(([k, v]) => `${k}(${v.length})`)].join(" | "));
for (const [name, f] of Object.entries(types)) {
  const all = rows.filter(f).length;
  console.log([name.slice(0, 36).padEnd(36), `${all} ${pct(all, rows.length)}`, ...cols.map(([, v]) => pct(v.filter(f).length, v.length))].join(" | "));
}
const show = process.argv.find((a) => a.startsWith("--show="))?.slice(7);
if (show && types[show]) {
  for (const p of rows.filter(types[show]).slice(-12)) {
    console.log(`==== ${p.at.slice(0, 10)} [${sceneOf(p.cust)}] ${p.act}`);
    console.log(`客: ${p.cust.replace(/\n/g, " ").slice(0, 140)}`);
    console.log(`AI: ${p.draft.replace(/\n/g, " / ").slice(0, 240)}`);
    console.log(`人: ${p.sent.replace(/\n/g, " / ").slice(0, 240)}`);
  }
}
