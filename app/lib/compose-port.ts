// app/lib/compose-port.ts — 文の受け口（統括 → 文 → 統括）。純関数の部分（受け取り・返す形・RAG の問いと並べ替え）
//
// 2026-11-04 作業員6（竹内さん了承「統括を作る」・作業員2がまとめ役・連携の表 E・取扱説明書 7）。
//   受け取る: Handoff（決まった事・あなたが決める事・守る線）＋統括メタ（場面・一番の要点・奥の心配の候補 等）＋ SceneSkill の writer の束＋要件の順。
//   返す:     設計図・下書き・外れ（blueprintOk＝handoffChecks に渡す）・根拠なし（no_ground＝統括が BrainRecheck from:no_ground で1回だけ戻す）。
//   統括の決定（AIX か返信か・一番の要点・要件の順）は決め直さない（何を言うかは判断・どう言うかは文）。
//   ⑤ 竹内さんの文の手本の倉庫（takeuchi_compose_examples）: 問いはお客様の発言と状況のまとめだけ。統括メタは絞り込み（場面・趣旨）と並べ替え（心配の札・前に進んだ重み）にだけ使う。
// スイッチは呼ぶ側（統括の段）で見る。テスト: app/lib/__tests__/compose-port.test.ts
import { blueprintDeviations, type ComposeBlueprint } from "./compose-blueprint";

export type ConductorComposeMeta = {
  scene: string | null;
  mainPoint?: string | null;
  /** 奥の心配（ブレインが決めた物。無ければ候補の札） */
  worries?: string[];
  purposeHint?: string | null;
};
export type ComposeReturn = {
  blueprint: ComposeBlueprint | null;
  draft: string;
  deviations: string[];
  /** handoffChecks の blueprintOk に渡す（設計図が無い番は null） */
  blueprintOk: boolean | null;
  sendBack: { kind: "no_ground"; why: string } | null;
};
/** 下書きを統括へ返す形にする */
export function composeReturnOf(o: { blueprint: ComposeBlueprint | null; draft: string; sendBack?: { kind: "no_ground"; why: string } | null }): ComposeReturn {
  const deviations = o.blueprint && o.draft.trim() ? blueprintDeviations(o.draft, o.blueprint) : [];
  return { blueprint: o.blueprint, draft: o.draft, deviations, blueprintOk: o.blueprint ? deviations.length === 0 : null, sendBack: o.sendBack ?? null };
}

/** RAG の問い: お客様の発言と状況のまとめだけ（統括メタ＝場面・趣旨・心配の札は問いに入れない） */
export function composeRagQuery(o: { customerText: string; situationSummary?: string | null }): string {
  return [`お客様: ${String(o.customerText ?? "").slice(0, 200)}`, o.situationSummary ? `状況: ${String(o.situationSummary).slice(0, 200)}` : ""].filter(Boolean).join("\n");
}
export type RagHitLite = { message_id: string; scene: string; purpose: string; similarity: number; score: number; weight: number; hidden_worry?: string[] | null; read_beyond?: string[] | null };
/** 並べ替え: 近さ×重み（倉庫の score）に、統括メタの心配の札が竹内さんの答えた札（read_beyond・hidden_worry）と重なる分を足す。上位 k */
export function rerankComposeHits<T extends RagHitLite>(hits: ReadonlyArray<T>, meta: Pick<ConductorComposeMeta, "worries">, k = 3): T[] {
  const ws = new Set(meta.worries ?? []);
  const bonus = (h: T) => {
    if (!ws.size) return 0;
    const tags = new Set([...(h.read_beyond ?? []), ...(h.hidden_worry ?? [])]);
    let n = 0; for (const w of ws) if (tags.has(w)) n++;
    return 0.05 * n;
  };
  return [...hits].map((h) => ({ h, s: h.score + bonus(h) })).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.h);
}
