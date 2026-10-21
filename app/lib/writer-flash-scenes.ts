// app/lib/writer-flash-scenes.ts — 返信の下書きを書く役を、試験で質が落ちない場面だけ DeepSeek の flash に回す（純関数・DB も fetch も持たない）
//
// 2026-10-21 ブレインの残り「書く役・最終チェックの flash 化（試験で質が落ちない場面だけ）」:
//   ・最終チェックは Claude のまま（竹内さん 10/18 の決定④「最終チェックは Claude のまま残す（質の線）」148d59dd）＝ここでは触らない。
//   ・書く役（reply_generate・今は deepseek-v4-pro）だけを、場面（reply-scene の ReplyScene＝ブレインが判断した場面）ごとに flash にする。
//     flash の時は flash-writer.ts の手当て（答える項目の一覧を最後に・抜けたら1回だけ書き直す）が自動で効く（10/18 の試験で pro 以上 27/42 対 25/42）。
//   ・既定 off（WRITER_FLASH_SCENES が無い／off）。on で既定の場面だけ・"property_share,conditions" のように場面を書けばその場面だけ。
//   ・既定の場面（WRITER_FLASH_DEFAULT_SCENES）は今ある試験の記録（mc1018 flash/pro 同じ16問×3回）で flash が pro と同じ以上だった場面だけ:
//       property_share（q157 物件ごとの答え flash 2/3・pro 1/3＝flash の手当ての的）・conditions（q018 条件のフォーム 3/3 対 3/3。q032 謝りの受けは手当ての的）。
//     外した場面: ack（q158・q172 で flash 2/6 対 pro 5/6）・considering（q174 0/3 対 1/3）・question（q069 0/3 対 1/3）・other（q164・q170 で落ちる）・
//       cost／viewing（記録が足りない）・apply（申込・審査＝個人情報に近い。設定に書いても回さない）。
//   ・個人情報の門は今のまま全部通る（入口 resolveDeepseekEntrance・審査の事情・出口の alt-pii-gate）。そのうえ flash は
//     「申込の記録が一度も無い会話（印 all）」・自動返信でない会話・続きの番／テンプレの最適化でない番だけ（線を引いた cut・並行の masked は pro のまま）。
// テスト: app/lib/__tests__/writer-flash-scenes.test.ts

import type { ReplyScene } from "./reply-scene";

export type EnvLike = Record<string, string | undefined>;

/** 書く役を flash に回す時の名札（llm-alt-provider がこの名札だけ DeepSeek の flash に送る・記録の action にも残る） */
export const WRITER_FLASH_ACTION = "reply_generate_flash";

/** WRITER_FLASH_SCENES=on の時の場面（試験の記録で flash が pro と同じ以上だった場面） */
export const WRITER_FLASH_DEFAULT_SCENES: readonly ReplyScene[] = ["property_share", "conditions"];

/** 設定に書いても flash に回さない場面（申込・審査＝個人情報に近い） */
const NEVER: ReadonlySet<string> = new Set(["apply"]);
const KNOWN: ReadonlySet<string> = new Set(["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply", "other"]);

/** flash に回す場面の集まり（off・無し＝null） */
export function writerFlashScenes(env: EnvLike = typeof process !== "undefined" ? process.env : {}): Set<ReplyScene> | null {
  const raw = (env.WRITER_FLASH_SCENES ?? "").trim().toLowerCase();
  if (!raw || raw === "off" || raw === "0" || raw === "false") return null;
  const list = raw === "on" || raw === "1" || raw === "true" ? [...WRITER_FLASH_DEFAULT_SCENES] : raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out = new Set<ReplyScene>();
  for (const s of list) if (KNOWN.has(s) && !NEVER.has(s)) out.add(s as ReplyScene);
  return out.size ? out : null;
}

export type WriterFlashInput = {
  scene: ReplyScene | null;
  /** 今の書く役が DeepSeek に回る時のモデル名（altDeepseekModelFor("reply_generate")・回らないなら null） */
  deepseekModel: string | null;
  /** 入口の印（post-apply の CutoffMark の kind） */
  cutMarkKind: "all" | "cut" | "blocked" | "masked" | null;
  autoSend: boolean;
  followUp: boolean;
  templateOptimize: boolean;
};

/** この番の書く役を flash にするか（理由つき・記録用） */
export function writerFlashDecision(i: WriterFlashInput, env: EnvLike = typeof process !== "undefined" ? process.env : {}): { on: boolean; why: string } {
  const scenes = writerFlashScenes(env);
  if (!scenes) return { on: false, why: "switch_off" };
  if (i.templateOptimize || i.followUp) return { on: false, why: "not_reply_turn" };
  if (!i.deepseekModel) return { on: false, why: "not_deepseek" };
  if (i.autoSend) return { on: false, why: "auto_send" };
  if (i.cutMarkKind !== "all") return { on: false, why: `mark_${i.cutMarkKind ?? "none"}` };
  if (!i.scene) return { on: false, why: "no_scene" };
  if (!scenes.has(i.scene)) return { on: false, why: `scene_${i.scene}` };
  return { on: true, why: `scene_${i.scene}` };
}
