// app/lib/mindset-move-table.ts — 「状態 × こちらの一手 → お客様の次の反応」の表（純関数・DB/LLM なし）
//
// 2026-10-09 竹内さん「これを言ったらお客さんが気に入って内覧につながるだろう・この物件を割引して送ったら申込するだろう…と予測して文を生成できているか。
//   人間の営業マン的思考」→ ③「状態×一手→反応の表は相関の材料としてブレインに渡してよい・テストで動かす（試験・YUMA で効き目を確かめてから）」
//
// ■ 数え方（scripts/audit-customer-mindset.ts --phase=move-table・竹内さんの番・送ってから7日以上たった番だけ）
//   状態＝DeepSeek で付けた状態を 12種（customer-mindset.MINDSET_STATES）に写した物。一手＝竹内さんの最初の送信（AIX の種類／返信の形＝決まった計算）。
//   反応＝返事（7日）・内覧（14日・viewings/viewing_history/deal_outcomes.viewing_at）・申込（30日・deal_outcomes.applied_at）。
//   成功の基準は申込到達（application-reach と同じ）。件数 10 未満のマスは渡さない。相関であって因果ではない（段階の偏りあり）。
//   表の中身は mindset-move-table-data.ts（スクリプトが書く・手で直さない）。
//
// 戻す・切り替え: MINDSET_MOVE_TABLE=on でブレインに渡す（既定は shadow＝渡さずログだけ）・off で何もしない
import { MINDSET_MOVE_TABLE_DATA, MINDSET_MOVE_TABLE_META } from "./mindset-move-table-data";

export type MoveCell = { state: string; move: string; n: number; convs: number; reply: number; view14: number; apply30: number };
export type MoveTableMode = "on" | "shadow" | "off";
export function moveTableMode(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): MoveTableMode {
  const v = (env.MINDSET_MOVE_TABLE ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "off" ? "off" : "shadow";
}

export const MOVE_TABLE_MIN_N = 10;

/** その状態の一手ごとの反応（件数の線を超えた物だけ・申込到達の高い順）。2つ以上ある時だけ返す（比べられる時だけ） */
export function movesForState(state: string | null | undefined, cells: ReadonlyArray<MoveCell> = MINDSET_MOVE_TABLE_DATA): MoveCell[] {
  if (!state) return [];
  const xs = cells.filter((c) => c.state === state && c.n >= MOVE_TABLE_MIN_N).sort((a, b) => b.apply30 - a.apply30 || b.n - a.n);
  return xs.length >= 2 ? xs : [];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** ブレインに渡す注記（材料だけ・言い回しの指示は書かない） */
export function buildMoveTableNote(state: string | null | undefined, cells?: ReadonlyArray<MoveCell>): string {
  const xs = movesForState(state, cells);
  if (!xs.length) return "";
  const lines = xs.slice(0, 5).map((c) => `- ${c.move}（${c.n}番・${c.convs}会話）: 返事 ${pct(c.reply)}・内覧14日 ${pct(c.view14)}・申込30日 ${pct(c.apply30)}`);
  return `【この状態（${state}）で竹内さんが打った一手と、その後の反応（${MINDSET_MOVE_TABLE_META.days}日・相関の材料・因果ではない・候補の一手ごとの見込みとして使う）】\n${lines.join("\n")}`;
}
