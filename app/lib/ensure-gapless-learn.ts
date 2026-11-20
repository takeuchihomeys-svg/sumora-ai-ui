/**
 * 学習課題の抜け止め関所（2026-11-18）
 *
 *   未学習・solid消失・新束後自動0・知見連携の穴があっても
 *   learning_tasks に対応 kind が必ず残るようにする。
 */
import { photoLearnLimitFor } from "./shot-learn-limit";

export type GaplessTask = {
  kind: string;
  what: string;
  why: string;
  cost: string;
  limit?: number;
  order?: "newest" | "time" | "size" | "sequence";
  fields?: string[];
};

export type GaplessInput = {
  tasks: GaplessTask[];
  unreadNormal?: number | null;
  weakFields?: string[] | null;
  kindConflictFields?: string[] | null;
  screenSolid?: number | null;
  readCount?: number | null;
  autoAfter?: boolean | null;
  reflectOk?: number | null;
  bottleneckN?: number | null;
  /** 写真はあるのに学べ0（vision段2）→ photo_learn を必ず出す */
  photoReach?: number | null;
  learnedOk?: number | null;
};

/**
 * 抜け止め: 足りない課題 kind を足す（既存は壊さない）。
 */
export function ensureGaplessLearnTasks(inp: GaplessInput): GaplessTask[] {
  const list = Array.isArray(inp.tasks) ? [...inp.tasks] : [];
  const has = (k: string) => list.some((t) => t && t.kind === k);
  const unread = Math.max(0, Number(inp.unreadNormal) || 0);
  // ★ 2026-11-20: null／未設定は「不明」。Number(null)=0 で「学習量が消えた」と誤判定していた（材料が無いのに課題を作らない）
  const solid = inp.screenSolid === null || inp.screenSolid === undefined ? NaN : Number(inp.screenSolid);
  const read = Number(inp.readCount);
  const fields = [
    ...(inp.weakFields || []),
    ...(inp.kindConflictFields || []),
  ].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 8);
  const bn = inp.bottleneckN ?? null;

  // solid 消失 → 復元反映が先（photo だけだと位置が戻らない）
  if (Number.isFinite(solid) && solid < 30 && !has("reflect_auto")) {
    list.unshift({
      kind: "reflect_auto",
      what: "履歴の画面位置を束に復元し、反映状態を確かめる",
      why: `screen_solid=${solid}（完了線≥30）。F1/F33: 消す書き込みを防ぎ履歴から継ぐ`,
      cost: "無料",
    });
  }

  const photoN = Math.max(0, Number(inp.photoReach) || 0);
  // ★ 2026-11-20: 学べた数も null は「不明」（0 と見ない）。材料が無いのに「学べ0」と判定しない
  const learnedN = inp.learnedOk === null || inp.learnedOk === undefined ? NaN : Math.max(0, Number(inp.learnedOk) || 0);
  /** ★ 2026-11-18 Pro: 写真あり∧学べ0∧todo窓0 でも flash 課題を出す */
  const needFlashThoughTodo0 = photoN > 0 && Number.isFinite(learnedN) && learnedN === 0;

  // 未学習 or 衝突欄があるのに photo_learn 無し（または写真あるのに学べ0）
  if ((unread > 0 || fields.length > 0 || needFlashThoughTodo0) && !has("photo_learn")) {
    // 段階4だけは拡張再読込が先（例外: 課題欄が束に無い時は photo も要る／flash未実行も例外）
    if (!(bn === 4 && fields.length === 0 && !needFlashThoughTodo0)) {
      list.push({
        kind: "photo_learn",
        what: fields.length
          ? "弱い／衝突欄を通常モードの最新画像から読む"
          : (needFlashThoughTodo0
            ? "写真はあるが学べ0 → flashで通常画像を読む（vision段2）"
            : "通常モードの画像を読んで画面位置・弱い所を強化する"),
        why: needFlashThoughTodo0
          ? `写真≈${photoN}枚・学べ=${learnedN}（todo窓=${unread}の誤報を止め flash を手配）`
          : (unread > 0
            ? `読める未学習 ${unread}枚${fields.length ? `／欄 ${fields.slice(0, 4).join("・")}` : ""}`
            : `衝突・弱い欄: ${fields.slice(0, 5).join("・")}`),
        cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
        limit: photoLearnLimitFor({
          todo: Math.max(unread, fields.length * 4, needFlashThoughTodo0 ? 8 : 0, 8),
          fieldCount: fields.length || 3,
        }),
        order: "newest",
        ...(fields.length ? { fields } : {}),
      });
    }
  }

  const solidOk = Number.isFinite(solid) && solid >= 30;
  if (
    Number.isFinite(read)
    && read >= 1
    && inp.autoAfter !== true
    && !has("need_auto_run")
    && (inp.autoAfter === false || solidOk)
  ) {
    list.push({
      kind: "need_auto_run",
      what: "自動モードで1回検索する（新束の効果を確かめる）",
      why: `solid=${Number.isFinite(solid) ? solid : "?"} read=${read} 新束後自動=0（F6/F38・段5『自動で使う』）`,
      cost: "無料（人の手間だけ）",
    });
  }

  if (has("photo_learn") && !has("reflect_auto")) {
    list.push({
      kind: "reflect_auto",
      what: "学んだ内容を束に載せ直し反映する（学んだら強化）",
      why: "読んだだけで終わらせない",
      cost: "無料",
    });
  }
  if (has("photo_learn") && !has("need_auto_run") && bn !== 4) {
    list.push({
      kind: "need_auto_run",
      what: "自動1回で強化できたか数字で見る",
      why: "学んだら自動へ反映して効果確認",
      cost: "無料（人の手間だけ）",
    });
  }
  if ((has("need_auto_run") || has("reflect_auto")) && !has("verify_improve") && Number(inp.reflectOk) === 0) {
    list.push({
      kind: "verify_improve",
      what: "learn_reflect_ok / aim有 で改善を確かめる",
      why: "F31/F43: 読んだだけでは改善済みにしない",
      cost: "無料",
    });
  }

  // 重複除去
  const seen = new Set<string>();
  const uniq = list.filter((t) => {
    const k = `${t.kind}|${t.what.slice(0, 36)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // ★ 2026-11-20 決まり「順番は無料で効く物が先・お金がかかる物は後ろ」: 費用ありは最後へ（無料どうしの順は変えない）
  const isPaid = (t: GaplessTask) => /費用|Vision/.test(t.cost || "");
  return [...uniq.filter((t) => !isPaid(t)), ...uniq.filter((t) => isPaid(t))];
}
