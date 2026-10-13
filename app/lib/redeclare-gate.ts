// redeclare-gate.ts — 出口の「見積作成宣言の繰り返し」「空室確認の再宣言」をブレイン基準に（2026-10-14 竹内さん「出口のゲートはブレイン基準ではないのが原因」・区切り2）
//
// 旧（validate-reply enforceAixGates）: 言葉だけを見て文を消していた。旗の立ち方も粗かった。
//   見積: 会話のどこかで1回でも見積書を送った（どの物件・何日前でも）か、直前のこちらの文が見積の約束 → 見積の文を全部消す
//   空室: 72時間以内に【物件確認した】か mgmt_* を押した（どの物件でも）→ 「管理会社」「募集状況」＋確認の文を全部消す
// 実送信（スタッフの手打ち 30日・scratchpad nonbrain/sim-gates.ts）で人の文を消した: 見積 50・空室 28（竹内さんの文も）。
//   中身は (1) 別の物件・別の日の約束（正しい新しい約束）(2) 結果の報告（「お送りさせて頂きました」「確認させて頂きましたところ」）。
// 直し（ここは純関数・DB/LLM なし）:
//   旗: 見積は物件ごと（aix_usage_logs.property_names とブレインの今の物件）・時間の窓（7日）・費用の質問なら（物件の参照が無くても）解除
//       空室は同じ物件の確認だけ（空室の話題の文だけ＝「管理会社」の語を外すのは validate-reply 側）
//   免除: (a) ブレインの本質（turn_contract）に見積／確認の約束か AIX がある (b) ブレインが AIX【見積書送る】【物件確認した】を選んだ
//         (c) contractProtectsSentence（validate-reply が protect で見る）
//   残す線: 見積書カバー文（送っていないのに送りました＝別の規則）・同じ物件への二重の約束（直前のこちらの文が同じ約束で、ブレインの免除が無い時）
// 戻す: REDECLARE_GATE_BRAIN=off（旧の旗・免除なし）

import { brainNameMatchesAny, parseLoose } from "./property-name-loose";
import type { TurnContract } from "./turn-contract";

export function redeclareGateBrainEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REDECLARE_GATE_BRAIN ?? "").toLowerCase() !== "off";
}

export type RedeclareAixLog = {
  aix_type: string | null;
  created_at: string | null;
  property_names?: string[] | null;
  estimate_sent?: boolean | null;
  check_pattern?: string | null;
};

export const ESTIMATE_REDECLARE_WINDOW_MS = 7 * 24 * 3600e3;
export const VACANCY_REDECLARE_WINDOW_MS = 72 * 3600e3;

/** ログの物件と今の物件が同じか（どちらかが分からない時は同じと見る＝旧の動き） */
export function logMatchesCurrent(logNames: ReadonlyArray<string> | null | undefined, current: ReadonlyArray<string>): boolean {
  const ln = (logNames ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  const cur = current.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!ln.length || !cur.length) return true;
  return cur.some((c) => brainNameMatchesAny(c, ln)) || ln.some((n) => brainNameMatchesAny(n, cur));
}

const fresh = (at: string | null, now: number, win: number) => { const t = Date.parse(at ?? ""); return Number.isFinite(t) && now - t >= -60_000 && now - t <= win; };

/**
 * 文が「見積書を送った物件とは別の物件」の見積を言っているか（「コーポ平野上町の初期費用…お見積書」で、送った見積の物件の名前と合わない）。
 * 名前が読めない・送った物件の名前が分からない時は false（旧の動き）
 */
export function sentenceNamesOtherProperty(sentence: string, sentNames: ReadonlyArray<string>): boolean {
  const names = sentNames.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!names.length) return false;
  const m = /([^\s、。！!？?「」『』（）()]{3,30}?)(?:\s*[0-9０-９]{2,4}号室)?の(?:初期費用|お見積書|御見積書|お見積り)/.exec(String(sentence ?? ""));
  if (!m) return false;
  const name = m[1].replace(/^(?:こちら|その|この|あの|それぞれ|また|なお|ご紹介の|お送り(?:頂|いただ)きました)/, "");
  const ref = parseLoose(name);
  if (!ref || ref.key.length < 4) return false;
  return !brainNameMatchesAny(name, names) && !names.some((n) => brainNameMatchesAny(n, [name]));
}

/** 見積の旗（見積作成宣言の繰り返しを消すか） */
export function estimateRedeclareArmed(i: {
  legacy: boolean;
  logs: ReadonlyArray<RedeclareAixLog>;
  now: number;
  currentProperties: ReadonlyArray<string>;
  /** お客様の今の連投に費用の質問・見積の依頼・金額の確認がある（物件の参照が無くても） */
  costAsk: boolean;
  /** 直前のこちらの文が見積の約束（STAFF_ESTIMATE_PROMISE_RE・新しい物件の費用の質問の時は false にしてある） */
  staffPromisedEstimate: boolean;
  env?: Record<string, string | undefined>;
}): { armed: boolean; reason: string } {
  if (!redeclareGateBrainEnabled(i.env)) return { armed: i.legacy, reason: "legacy" };
  if (i.costAsk) return { armed: false, reason: "cost_ask" };
  const sent = i.logs.filter((l) => (l.aix_type === "estimate_sheet" || l.estimate_sent) && fresh(l.created_at, i.now, ESTIMATE_REDECLARE_WINDOW_MS));
  const same = sent.filter((l) => logMatchesCurrent(l.property_names, i.currentProperties));
  if (same.length) return { armed: true, reason: "sent_same_property" };
  if (i.staffPromisedEstimate) return { armed: true, reason: "staff_promised" };
  return { armed: false, reason: sent.length ? "sent_other_property" : "not_sent_in_window" };
}

/** 空室の旗（空室確認の再宣言を消すか）。legacy＝route の aixDone.vacancyCheck||mgmtCheck（新しい物件の参照・再確認の依頼で解除済み） */
export function vacancyRedeclareArmed(i: {
  legacy: boolean;
  logs: ReadonlyArray<RedeclareAixLog>;
  now: number;
  currentProperties: ReadonlyArray<string>;
  env?: Record<string, string | undefined>;
}): { armed: boolean; reason: string } {
  if (!redeclareGateBrainEnabled(i.env)) return { armed: i.legacy, reason: "legacy" };
  if (!i.legacy) return { armed: false, reason: "not_done" };
  const done = i.logs.filter((l) => (l.aix_type === "property_check_result" || (l.check_pattern ?? "").startsWith("mgmt_")) && fresh(l.created_at, i.now, VACANCY_REDECLARE_WINDOW_MS));
  if (!done.length) return { armed: false, reason: "not_done" };
  return done.some((l) => logMatchesCurrent(l.property_names, i.currentProperties))
    ? { armed: true, reason: "checked_same_property" }
    : { armed: false, reason: "checked_other_property" };
}

/** ブレインがこの番で見積／確認の約束（か AIX）を決めているか（免除 a・b） */
export function brainKeepsRedeclare(contract: TurnContract | null | undefined, suggestedAixAction: string | null | undefined, env?: Record<string, string | undefined>): { estimate: boolean; vacancy: boolean } {
  if (!redeclareGateBrainEnabled(env)) return { estimate: false, vacancy: false };
  const aix = String(suggestedAixAction ?? "");
  let estimate = /^estimate_sheet\b/.test(aix);
  let vacancy = /^property_check_result\b|^acknowledge_check\b/.test(aix);
  if (contract && contract.source === "brain") {
    for (const a of contract.asks) {
      if (a.route !== "promise" && a.route !== "aix") continue;
      const k = `${a.aixKey ?? ""} ${a.answer ?? ""}`;
      if (a.topic === "cost" || /estimate_sheet|見積/.test(k)) estimate = true;
      if (a.topic === "vacancy" || /property_check_result|物件確認|募集状況|空室|空き/.test(k)) vacancy = true;
    }
  }
  return { estimate, vacancy };
}
