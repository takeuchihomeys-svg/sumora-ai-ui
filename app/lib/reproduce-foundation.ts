/**
 * 完全再現のための土台細分化（2026-11-16 竹内さん）
 *
 *   「土台強化細分化して強化」「自動モードの録画みて弱い部分を見つける」
 *   「細部にこだわれば完全に人間の動きで行うことができる」
 *
 * ★ なぜ要るか
 *   再現 35% とだけ言っても直らない。足りない物を**実際に何が必要か**まで分解し、
 *   ①自動録画で見つける → ②通常録画から学ぶ → ③土台を作る → ④細部を再現 → ⑤確かめる
 *   を統括が1本の連動として回す。
 *
 * ⚠ 純関数。DBに書かない・サイトを触らない。
 */
import { linkFieldsToScenes, SCENE_JA, type FlowScene, type SceneFlow } from "./learn-flow-steps";

/** 循環の段（細分化の層） */
export type ReproduceLayer = "find" | "learn" | "foundation" | "detail" | "verify";

export const LAYER_JA: Record<ReproduceLayer, string> = {
  find: "見つける（自動録画）",
  learn: "学ぶ（通常録画）",
  foundation: "土台を作る",
  detail: "細部を再現する",
  verify: "確かめる",
};

/** 1つの足りない物（細分化の原子） */
export type FoundationAtom = {
  id: string;
  layer: ReproduceLayer;
  /** 何が足りないか（短い） */
  what: string;
  /** 実際に何が必要か（細分化の核心） */
  need: string;
  /** 材料の出所 */
  from: "auto_rec" | "normal_rec" | "bundle" | "ext" | "human";
  field?: string;
  scene?: FlowScene;
  sceneJa?: string;
  how: string;
};

export type SubdivideInput = {
  /** 再現％（0〜100） */
  reproducePct?: number | null;
  reproduceRemain?: string[];
  humanLike?: {
    ops: number;
    changedWithoutClick: number;
    changedWithoutClickFields?: string[];
    typedOnChoose?: number;
    withCursor: number;
    withPoint: number;
    rows: number;
    handCursorClicks?: number;
  } | null;
  /** 自動の最新課題欄 */
  challengeFields?: string[];
  /** 押し直しなど */
  reclickFields?: string[];
  /** 自動改善候補の要約 */
  autoFixTop?: Array<{ what: string; why: string; how: string }>;
  /** 束の反映 */
  bundleReflect?: { read_count?: number; screen_solid?: number; auto_after?: boolean } | null;
  /** 場面の手本 */
  sceneFlows?: SceneFlow[] | null;
  stoppedScene?: string | null;
};

/**
 * 足りない物を「実際に何が必要か」まで細分化する（純関数）。
 */
export function subdivideReproduceGaps(input: SubdivideInput): FoundationAtom[] {
  const out: FoundationAtom[] = [];
  const push = (a: FoundationAtom) => {
    if (out.some((x) => x.id === a.id)) return;
    out.push(a);
  };

  const h = input.humanLike && input.humanLike.ops > 0 ? input.humanLike : null;
  const challenges = Array.isArray(input.challengeFields) ? input.challengeFields.map(String).filter(Boolean) : [];
  const reclicks = Array.isArray(input.reclickFields) ? input.reclickFields.map(String).filter(Boolean) : [];
  const flows = input.sceneFlows;

  // ── ① 見つける（自動録画）──
  for (const f of challenges.slice(0, 8)) {
    const links = linkFieldsToScenes([f], flows);
    const sc = links[0];
    push({
      id: `find:direct:${f}`,
      layer: "find",
      what: `自動が押さず変化（${f}）`,
      need: `${f} をカーソル→開く→押す手順で動かす材料（通常の押し方）`,
      from: "auto_rec",
      field: f,
      scene: sc?.scene,
      sceneJa: sc?.sceneJa,
      how: "自動録画の課題として記録済み → 通常録画の同欄から学ぶ",
    });
  }
  for (const f of reclicks.slice(0, 6)) {
    const isWard = /city_code|区を選ぶ|one_city|町字/.test(f);
    push({
      id: `find:reclick:${f}`,
      layer: "find",
      what: `自動が押し直し（${f}）`,
      need: isWard
        ? `${f} は「選ぶ」だけでなく前客の区を1つずつ外す（トグル）型が要る`
        : `${f} を1回で決まる押し方（迷い・二重押しをやめる）`,
      from: "auto_rec",
      field: f,
      how: isWard
        ? "通常の区外し（条件外だけ click・条件内は触らない）→ 束 opens/順番 → 自動の外し"
        : "自動録画の押し直し → 通常の同場面の順番と比較",
    });
    if (isWard) {
      push({
        id: "foundation:ward-off",
        layer: "foundation",
        what: "前客の区を外す土台",
        need: "条件外の区だけカーソル→押して外す（北・中央・西など残す区は触らない）。was→now で外しを記録",
        from: "normal_rec",
        field: f,
        scene: "area",
        sceneJa: SCENE_JA.area,
        how: "くれあ通常録画の区外し（福島・都島等OFF）を学び、自動の preclear/外しに写す",
      });
    }
  }
  for (const fx of (input.autoFixTop || []).slice(0, 3)) {
    push({
      id: `find:fix:${fx.what.slice(0, 24)}`,
      layer: "find",
      what: fx.what,
      need: fx.why || "自動録画から弱い所を特定",
      from: "auto_rec",
      how: fx.how || "通常から改善",
    });
  }

  // ── ② 学ぶ（通常録画）──
  const learnFields = [...new Set([...challenges, ...(h?.changedWithoutClickFields || [])])].slice(0, 8);
  for (const f of learnFields) {
    const links = linkFieldsToScenes([f], flows);
    const sc = links[0];
    push({
      id: `learn:${f}`,
      layer: "learn",
      what: `通常から ${f} の押し方を学ぶ`,
      need: `通常モードの画像・操作で ${f} の種類・位置・click→change を束に載せる`,
      from: "normal_rec",
      field: f,
      scene: sc?.scene,
      sceneJa: sc?.sceneJa,
      how: sc?.hasExample
        ? `場面「${sc.sceneJa}」の手本あり（${sc.runs}回）→ photo_learn / 操作の束`
        : `場面「${sc?.sceneJa || "？"}」の手本が薄い → 通常でその場面を録画してから学ぶ`,
    });
  }

  // ── ③ 土台を作る ──
  if (h) {
    const cursorPct = h.rows > 0 ? Math.round((h.withCursor / h.rows) * 100) : 0;
    const pointPct = h.rows > 0 ? Math.round((h.withPoint / h.rows) * 100) : 0;
    if (h.changedWithoutClick > 0) {
      push({
        id: "foundation:no-direct-write",
        layer: "foundation",
        what: "直書き禁止の土台",
        need: "value/checked 直書き経路をやめ、chooseSelectLikeHuman / カーソル→押すに統一",
        from: "bundle",
        how: "拡張の直書き箇所を直し、通常録画の押し方を束に反映",
      });
    }
    if (cursorPct < 70) {
      push({
        id: "foundation:cursor-moves",
        layer: "foundation",
        what: `カーソル移動の土台（今 ${cursorPct}%）`,
        need: "自動の各操作の前に見えるカーソル移動（moves）が残る記録と実装",
        from: "normal_rec",
        how: "通常のカーソル軌跡を学び、自動の enqueue が同じ順で動く",
      });
    }
    if (pointPct < 50) {
      push({
        id: "foundation:press-point",
        layer: "foundation",
        what: `押した位置の土台（今 ${pointPct}%）`,
        need: "欄ごとの押す座標（n≥2）が束にあり、自動がそこへ当てる",
        from: "normal_rec",
        how: "通常の point_fields / 画像位置 → 束 → 拡張",
      });
    }
    if ((h.handCursorClicks ?? 0) === 0 && h.ops >= 20) {
      push({
        id: "foundation:hand-cursor",
        layer: "foundation",
        what: "手の形（pointer）の土台",
        need: "通常録画の shot_ops.cs=pointer → 束 cursor_hand → 見える手が付く",
        from: "human",
        how: "拡張2.8.22でボタン操作を通常録画 → 束取り直し",
      });
    }
  }
  const br = input.bundleReflect;
  if (br && (br.screen_solid ?? 0) >= 3 && (br.read_count ?? 0) <= 0) {
    push({
      id: "foundation:bundle-read",
      layer: "foundation",
      what: "拡張が束を読む土台",
      need: "read_count>0（拡張2.8.24再読込→ポップアップで学習再取得）",
      from: "ext",
      how: "chrome://extensions で再読込 → ポップアップ／学習の再取得",
    });
  }

  // ── ④ 細部を再現する ──
  for (const f of learnFields.slice(0, 6)) {
    const links = linkFieldsToScenes([f], flows);
    const sc = links[0];
    push({
      id: `detail:${f}`,
      layer: "detail",
      what: `${f} を人間と同じ細部で再現`,
      need: "カーソル接近→形（手/矢印）→開く→行へ移動→押す→change（間のタイミング含む）",
      from: "normal_rec",
      field: f,
      scene: sc?.scene,
      sceneJa: sc?.sceneJa,
      how: "通常の同場面の手数・間・順番を自動の1手に写す",
    });
  }
  if (input.stoppedScene) {
    push({
      id: `detail:stop:${input.stoppedScene}`,
      layer: "detail",
      what: `止まる場面「${input.stoppedScene}」の細部`,
      need: "手本の最後数手と自動の最後数手を比較し、抜け・順違いを直す",
      from: "auto_rec",
      how: "fix_scene（手本と比べる）",
    });
  }

  // ── ⑤ 確かめる ──
  if ((input.reproducePct != null && input.reproducePct < 100) || challenges.length > 0 || (br && !br.auto_after)) {
    push({
      id: "verify:effect",
      layer: "verify",
      what: "効果確認（再現％・課題欄）",
      need: "自動1回のあと 直書き0・カーソル≥70%・押した位置≥50%・手の形あり／課題欄が減る",
      from: "auto_rec",
      how: "need_auto_run → verify_improve",
    });
  }

  return out;
}

/** 層ごとの件数と1行要約（統括の根拠用） */
export function summarizeAtoms(atoms: ReadonlyArray<FoundationAtom>): {
  byLayer: Record<ReproduceLayer, number>;
  line: string;
  topNeeds: string[];
} {
  const byLayer: Record<ReproduceLayer, number> = {
    find: 0, learn: 0, foundation: 0, detail: 0, verify: 0,
  };
  for (const a of atoms) byLayer[a.layer]++;
  const parts = (Object.keys(LAYER_JA) as ReproduceLayer[])
    .filter((k) => byLayer[k] > 0)
    .map((k) => `${LAYER_JA[k]} ${byLayer[k]}`);
  const topNeeds = atoms.slice(0, 6).map((a) => a.need);
  return {
    byLayer,
    line: parts.length
      ? `細分化 ${atoms.length}件（${parts.join("・")}）→ 細部まで揃えれば人間の動きに近づく`
      : "細分化する抜けなし",
    topNeeds,
  };
}

/** 連動の1行: 自動で見つける → 通常で学ぶ → 土台 → 細部 → 確かめる */
export function linkageLine(atoms: ReadonlyArray<FoundationAtom>): string {
  const has = (L: ReproduceLayer) => atoms.some((a) => a.layer === L);
  const mark = (ok: boolean, label: string) => (ok ? `✓${label}` : `○${label}`);
  return [
    mark(has("find"), "自動で弱所"),
    mark(has("learn"), "通常で学ぶ"),
    mark(has("foundation"), "土台"),
    mark(has("detail"), "細部再現"),
    mark(has("verify"), "確かめる"),
  ].join(" → ") + "（連動して回す）";
}

/** 学習課題に載せる短冊（統括の learning_tasks 用の材料） */
export function atomsToTaskHints(atoms: ReadonlyArray<FoundationAtom>): Array<{
  kind: "photo_learn" | "build_foundation" | "fix_scene" | "need_human" | "need_auto_run" | "verify_improve";
  what: string;
  why: string;
  fields?: string[];
}> {
  const out: Array<{
    kind: "photo_learn" | "build_foundation" | "fix_scene" | "need_human" | "need_auto_run" | "verify_improve";
    what: string;
    why: string;
    fields?: string[];
  }> = [];
  const learnFields = atoms.filter((a) => a.layer === "learn" && a.field).map((a) => a.field!);
  if (learnFields.length) {
    out.push({
      kind: "photo_learn",
      what: "自動で見つけた弱所を、通常録画から細分化して学ぶ",
      why: `欄: ${learnFields.slice(0, 5).join("・")}／実際に必要なのは押し方・位置・種類`,
      fields: [...new Set(learnFields)].slice(0, 8),
    });
  }
  if (atoms.some((a) => a.layer === "foundation")) {
    const needs = atoms.filter((a) => a.layer === "foundation").map((a) => a.what).slice(0, 3);
    out.push({
      kind: "build_foundation",
      what: "足りない土台を細分化してそろえる",
      why: needs.join("／"),
    });
  }
  if (atoms.some((a) => a.layer === "detail" && a.id.startsWith("detail:stop:"))) {
    const s = atoms.find((a) => a.id.startsWith("detail:stop:"));
    out.push({
      kind: "fix_scene",
      what: s?.what || "止まる場面の細部を手本と比べる",
      why: s?.need || "",
    });
  }
  if (atoms.some((a) => a.layer === "foundation" && a.id === "foundation:hand-cursor")) {
    out.push({
      kind: "need_human",
      what: "通常モードで手が付くボタンを1回録画（手の形の土台）",
      why: "cs=pointer が無いと細部の手の形が再現できない",
    });
  }
  if (atoms.some((a) => a.layer === "verify")) {
    out.push({
      kind: "need_auto_run",
      what: "自動1回で細部再現の効果を確かめる",
      why: "細分化した土台が効いたかを数字で見る",
    });
  }
  return out;
}

/** SCENE_JA を外から使う用に再輸出 */
export { SCENE_JA };
