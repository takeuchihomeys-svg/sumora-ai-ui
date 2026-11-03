// app/lib/brain-recheck.ts — 読み直しの口（opts.recheck）の形と材料の1行（純関数）
//
// 2026-11-03 設計の案 fetch-think-design.md「読み直しの口を1つに」: 差し戻し（AIX の統括 → not_aix／promise）・逆向きの相談（返信の番 → AIX の番）・
//   根拠なし（作業員6 no_ground）・取りに行った材料（fetch）・深く読む（deep）を、同じ形で analyzeConversation に渡す。
//   読み直しは1番につき1回まで。呼ぶのは analyzeAndSaveBrainMeta の中だけ（webhook・bg-async・cron はみなここを通る）＝呼ぶ側を増やさない。
//   決めるのはブレイン（材料の1行を足して読み直すだけ・答えを差し替えない）。旧 opts.sendBack はこの形に読み替える（aix-sendback.ts の文はそのまま）。
import type { AixSendBack } from "./aix-sendback";
import { sendBackMaterialLine } from "./aix-sendback";

export type RecheckFrom = "aix_desk" | "aix_consult" | "no_ground" | "fetch" | "deep";
export type BrainRecheck = {
  /** 誰からの読み直しか */
  from: RecheckFrom;
  /** not_aix＝AIX ではない／promise＝確かめる約束の返信に／aix＝AIX の番（key に AIX の鍵）／reread＝材料を足して読み直すだけ */
  kind: "not_aix" | "promise" | "aix" | "reread";
  key?: string | null;
  why: string;
  /** 最初の判断の AIX（無ければ null＝返信） */
  firstAix?: string | null;
  /** fetch／deep で取ってきた材料（短く・ある時だけ） */
  material?: string | null;
};

export const recheckFromSendBack = (sb: AixSendBack | null | undefined, firstAix?: string | null): BrainRecheck | null =>
  sb ? { from: "aix_desk", kind: sb.kind, why: sb.why, firstAix: firstAix ?? null } : null;

const one = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function recheckMaterialLine(rc: BrainRecheck | null | undefined): string {
  if (!rc || !one(rc.why, 1)) return "";
  if (rc.from === "aix_desk" && (rc.kind === "not_aix" || rc.kind === "promise")) return sendBackMaterialLine({ kind: rc.kind, why: rc.why }, rc.firstAix ?? null);
  const first = rc.firstAix ? `AIX ${rc.firstAix}` : "返信";
  const head = `【読み直し（材料・1回だけ）】あなたの最初の判断（${first}）について`;
  const tail = "会話をもう一度読み、同じ連投の他の依頼も落とさないように決め直す（会話と合わない時は最初の判断のままでよい）。";
  if (rc.kind === "aix") return `${head}、AIX の担当が「スタッフしか知らない事・確認が要る事があり、AIX${rc.key ? ` ${one(rc.key, 40)}` : ""} の番かもしれない」と返した。理由: ${one(rc.why, 120)}。${tail}`;
  if (rc.kind === "promise") return `${head}、「今は返せる結果・物が無いので、確かめる約束の返信にすべきかもしれない」と返った。理由: ${one(rc.why, 120)}。${tail}`;
  if (rc.kind === "not_aix") return `${head}、「AIX の番ではないかもしれない」と返った。理由: ${one(rc.why, 120)}。${tail}`;
  const mat = one(rc.material, 600);
  return `${head}、${rc.from === "no_ground" ? "文の根拠が材料に見つからなかった" : rc.from === "deep" ? "深く読む番と判断された" : "足りない材料を取ってきた"}。理由: ${one(rc.why, 120)}。${mat ? `\n${mat}\n` : ""}${tail}`;
}
