// app/lib/playbook-served.ts — 拡張の「版だけ見る軽い確認」(touch=0) が返す手順書の決まり版（純関数・DB を使わない・2.8.310）
//
// 竹内さん「手順書が古いまま残る原因を見つけて、最新が自動で反映される仕組みに」（2026-11-26）。
//   実測: 軽い確認は DB の行に書かれた手順書の版（rules_v）をそのまま返していた。
//   ところが実際に拡張へ渡す束は、渡す時に `refreshPlaybookIfStale` で今のコードの手順書に作り直される（DB は書かない）。
//   → 拡張は「版が同じ」と見て取りに行かず、コードの決まりを直しても DB を書き直すまで古い手順書を使い続けた。
//   → 軽い確認も「渡す時の版」を返す（＝作り直しが要る時はコードの版）。これで DB を書かなくても拡張が取りに行く。
//
// ⚠ ここの条件は refreshPlaybookIfStale（action-playbook.ts）と**同じ**にする。食い違ったら
//   app/lib/__tests__/playbook-served.test.ts が落ちる（2 つの見方が別々にずれないための網）。

export type PlaybookVersionIn = { rules_v?: unknown; build_v?: unknown } | null | undefined;

export type ServedPlaybookVersion = {
  /** 拡張に返す決まり版（作り直しが要る時はコードの版） */
  rules_v: string;
  /** DB の手順書は作り直しが要る（＝渡す時に作り直される） */
  stale: boolean;
  why: string | null;
};

export function servedPlaybookRulesV(
  db: PlaybookVersionIn,
  code: { rules_v: string; build_v: number },
): ServedPlaybookVersion {
  const dbRules = db && typeof db === "object" && db.rules_v != null ? String(db.rules_v) : "";
  if (!db || typeof db !== "object" || !dbRules) {
    return { rules_v: code.rules_v, stale: true, why: "手順書が無い" };
  }
  const dbBuild = Number(db.build_v) || 0;
  if (dbBuild < code.build_v) {
    return { rules_v: code.rules_v, stale: true, why: `作り方が古い（${dbBuild || "-"}→${code.build_v}）` };
  }
  if (dbRules !== code.rules_v) {
    return { rules_v: code.rules_v, stale: true, why: `決まりの版が古い（${dbRules}→${code.rules_v}）` };
  }
  return { rules_v: dbRules, stale: false, why: null };
}
