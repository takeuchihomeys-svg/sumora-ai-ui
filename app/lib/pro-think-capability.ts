/**
 * 統括Proの「考える能力」土台（2026-11-18 竹内さん）
 *
 *   「統括proは何が足りていないか／どうすれば強化されるか、改善されるか、
 *    考える能力を持つ仕組みを作るように構築する」
 *   「画像学習はちゃんとおこなったのか／細かく強化／細かい部分まで徹底」
 *
 * ★ なぜ要るか
 *   Pro に「判断せよ」と書くだけでは、axes が薄い時に空回りする。
 *   → **考える順番と材料の穴**を決定論で先に並べ、Pro はその上で仮説→次手を書く。
 *
 * ⚠ 純関数。推測で弱点を増やさない（入力の数字・弱所名だけ）。
 */

export type ProThinkMissing = {
  id: string;
  /** 何が足りないか */
  what: string;
  /** 根拠（数字・印） */
  evidence: string;
  layer: "photo" | "flash" | "material" | "gate" | "ext" | "auto" | "pro" | "memory";
};

export type ProThinkHow = {
  id: string;
  /** どう強化／改善するか */
  how: string;
  /** 対応する missing id */
  for_missing: string;
  cost: "free" | "flash" | "ext" | "human";
};

export type ProThinkFineAtom = {
  id: string;
  field: string;
  gap: string;
  next: string;
  facet: "kind" | "position" | "press" | "cursor" | "clear" | "scene" | "pipeline";
};

export type ProThinkCapability = {
  /** 考える順番（Proが必ず辿る） */
  think_order: string[];
  missing: ProThinkMissing[];
  strengthen: ProThinkHow[];
  improve: ProThinkHow[];
  fine_atoms: ProThinkFineAtom[];
  /** 画像学習はちゃんと行われたか */
  image_learn: {
    done: boolean | null;
    line: string;
    gaps: string[];
  };
  bottleneck: string | null;
  line: string;
  /** Pro に渡す短い思考骨格 */
  scaffold: string;
};

export type ProThinkInput = {
  /** vision 連携段 */
  visionBottleneckN?: number | null;
  visionLine?: string | null;
  photoInStorage?: number | null;
  learnedOk?: number | null;
  todo?: number | null;
  photoKindsN?: number | null;
  withScreenPos?: number | null;
  matched?: number | null;
  hasPhotoLearnTask?: boolean | null;
  /** 画面位置が中央固定（0.5/0.5）ばかり＝細部未学習 */
  centerOnlyPosN?: number | null;
  solidPosN?: number | null;
  /** 写真内の種類衝突 */
  kindConflictN?: number | null;
  kindConflictFields?: string[] | null;
  /** 記録 vs 写真の食い違い */
  photoVsRecordN?: number | null;
  photoVsRecordFields?: string[] | null;
  /** 束→拡張 */
  readCount?: number | null;
  autoAfter?: boolean | null;
  /** 土台欠 */
  foundationMissingN?: number | null;
  /** 1録画ループ止 */
  oneRecBottleneck?: string | null;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/**
 * 統括Proが「足りない→強化→改善」を考えるための骨格を組む。
 */
export function buildProThinkCapability(inp: ProThinkInput): ProThinkCapability {
  const photo = n(inp.photoInStorage);
  const learned = n(inp.learnedOk);
  const todo = n(inp.todo);
  const kinds = n(inp.photoKindsN);
  const pos = n(inp.withScreenPos);
  const matched = n(inp.matched);
  const center = n(inp.centerOnlyPosN);
  const solid = n(inp.solidPosN);
  const conflictN = n(inp.kindConflictN);
  const vsN = n(inp.photoVsRecordN);
  const read = n(inp.readCount);
  const missF = n(inp.foundationMissingN);
  const vb = inp.visionBottleneckN ?? null;

  const missing: ProThinkMissing[] = [];
  const strengthen: ProThinkHow[] = [];
  const improve: ProThinkHow[] = [];
  const fine: ProThinkFineAtom[] = [];
  const pushM = (m: ProThinkMissing) => {
    if (missing.some((x) => x.id === m.id)) return;
    missing.push(m);
  };
  const pushS = (h: ProThinkHow) => {
    if (strengthen.some((x) => x.id === h.id)) return;
    strengthen.push(h);
  };
  const pushI = (h: ProThinkHow) => {
    if (improve.some((x) => x.id === h.id)) return;
    improve.push(h);
  };
  const pushF = (a: ProThinkFineAtom) => {
    if (fine.some((x) => x.id === a.id)) return;
    fine.push(a);
  };

  // ── 画像学習はちゃんと行われたか ──
  const imageGaps: string[] = [];
  if (photo === 0 && learned === 0 && todo === 0) {
    imageGaps.push("写真材料の数字が統括に届いていない（または0）");
  }
  if (todo > 0 && learned === 0) {
    imageGaps.push(`未学習${todo}なのに学べ済み0（flash未実行）`);
  }
  if (todo > 0 && inp.hasPhotoLearnTask !== true) {
    imageGaps.push(`未学習${todo}なのに photo_learn 課題なし`);
  }
  if (learned > 0 && kinds === 0) {
    imageGaps.push(`学べ${learned}あるが種類材料0（統括に未到達）`);
  }
  if (center > 0 && solid === 0) {
    imageGaps.push(`位置が中央固定ばかり${center}欄（細部の位置学習が薄い）`);
  }
  if (conflictN > 0) {
    imageGaps.push(`写真内種類衝突${conflictN}（細かく再読が要る）`);
  }
  if (vsN > 0) {
    imageGaps.push(`記録≠写真${vsN}（select/click取り違え等）`);
  }
  const imageDone =
    learned > 0 && kinds > 0 && todo === 0 && conflictN === 0 && vsN === 0 && !(center > 3 && solid < 1)
      ? true
      : learned > 0 || kinds > 0 || photo > 0
        ? false
        : null;
  const imageLine = imageDone === true
    ? `画像学習✓ 学べ${learned}・種類${kinds}・未読0・衝突0`
    : imageDone === false
      ? `画像学習は途中／穴あり: ${imageGaps.slice(0, 3).join("／") || inp.visionLine || "細部未達"}`
      : `画像学習の判定材料不足（vision/shot数字が薄い）`;

  // ── missing / strengthen / improve ──
  if (vb != null && vb <= 2) {
    pushM({
      id: "vision_flash",
      what: "flashで画像を読む工程",
      evidence: inp.visionLine || `bottleneck=${vb} learned=${learned} todo=${todo}`,
      layer: "flash",
    });
    pushS({
      id: "s_flash",
      for_missing: "vision_flash",
      how: "photo_learn（flash）で未学習を読む。枚数は統括が課題に応じて決める",
      cost: "flash",
    });
  }
  if (todo > 0 && inp.hasPhotoLearnTask !== true) {
    pushM({
      id: "photo_learn_task",
      what: "未学習があるのに photo_learn 課題が無い",
      evidence: `todo=${todo}`,
      layer: "gate",
    });
    pushS({
      id: "s_pl_task",
      for_missing: "photo_learn_task",
      how: "決定論の learning_tasks に photo_learn を載せる（足りると分かっているのに出さない禁止）",
      cost: "free",
    });
  }
  if (learned > 0 && kinds === 0) {
    pushM({
      id: "kinds_reach",
      what: "読んだ種類が統括材料に届いていない",
      evidence: `learned=${learned} kinds=0`,
      layer: "material",
    });
    pushS({
      id: "s_kinds",
      for_missing: "kinds_reach",
      how: "サイト別統括へ photo_kinds / shot_bytes を渡す（F49）",
      cost: "free",
    });
  }
  if (center > 3 && solid < 1) {
    pushM({
      id: "pos_detail",
      what: "押す位置の細部学習（中央固定だらけ）",
      evidence: `centerOnly=${center} solid=${solid}`,
      layer: "flash",
    });
    pushS({
      id: "s_pos",
      for_missing: "pos_detail",
      how: "欄×観点の position を最優先で flash。n≥1 thin でも束へ載せる",
      cost: "flash",
    });
    pushI({
      id: "i_pos_auto",
      for_missing: "pos_detail",
      how: "束反映→拡張再読込→learn_warm→aim有→自動1回で point_pct を測る",
      cost: "ext",
    });
  }
  if (conflictN > 0) {
    pushM({
      id: "kind_conflict",
      what: "写真内の種類衝突（細かい再読）",
      evidence: `n=${conflictN} fields=${(inp.kindConflictFields || []).slice(0, 6).join(",")}`,
      layer: "flash",
    });
    pushS({
      id: "s_conflict",
      for_missing: "kind_conflict",
      how: "衝突欄だけ追加flash。既知selectは種類再判定せず位置・押し方へ",
      cost: "flash",
    });
    for (const f of (inp.kindConflictFields || []).slice(0, 6)) {
      pushF({
        id: `fc_${f}`,
        field: f,
        gap: "写真内で種類が揺れる",
        next: /rental_cost|update_date|square_meter|structured_date|transportation|required_time/i.test(f)
          ? "select正本→位置・開いて選ぶを強化（種類の再判定禁止）"
          : "次の写真で多数決／領域を細かく読む",
        facet: /rental_cost|update_date|square|structured|transport|required_time/i.test(f) ? "position" : "kind",
      });
    }
  }
  if (vsN > 0) {
    pushM({
      id: "photo_vs_record",
      what: "記録と写真の食い違い",
      evidence: `n=${vsN} fields=${(inp.photoVsRecordFields || []).slice(0, 6).join(",")}`,
      layer: "material",
    });
    pushS({
      id: "s_vs",
      for_missing: "photo_vs_record",
      how: "食い違い欄を1つずつ突合。既知selectは写真click揺れを捨てて記録selectを正とする",
      cost: "free",
    });
    for (const f of (inp.photoVsRecordFields || []).slice(0, 6)) {
      pushF({
        id: `fv_${f}`,
        field: f,
        gap: "記録≠写真の種類",
        next: "既知selectなら位置学習へ／そうでなければ追加録画で確かめる",
        facet: "kind",
      });
    }
  }
  if (read < 1 && (learned > 0 || kinds > 0 || pos > 0)) {
    pushM({
      id: "bundle_read",
      what: "学んだ結果を拡張が読んでいない",
      evidence: `read_count=${read}`,
      layer: "ext",
    });
    pushI({
      id: "i_reload",
      for_missing: "bundle_read",
      how: "拡張再読込→ポップアップで束取込→自動1回（読んだだけで改善済みにしない）",
      cost: "ext",
    });
  }
  if (inp.autoAfter !== true && read >= 1) {
    pushM({
      id: "auto_verify",
      what: "新束後の自動1回（効果確認）",
      evidence: "auto_after=false",
      layer: "auto",
    });
    pushI({
      id: "i_auto",
      for_missing: "auto_verify",
      how: "自動1回→F31/F32/point/aim/layout_pre_search_ok を数字で見る",
      cost: "human",
    });
  }
  if (missF > 0) {
    pushM({
      id: "foundation",
      what: `学習土台の欠 ${missF}`,
      evidence: `foundation_missing=${missF}`,
      layer: "pro",
    });
    pushS({
      id: "s_fa",
      for_missing: "foundation",
      how: "欠F番号を優先順で埋める（無料の関所→flash→人）",
      cost: "free",
    });
  }
  if (inp.oneRecBottleneck) {
    pushM({
      id: "one_rec",
      what: "1録画→学習→改善→反映が途中で止まっている",
      evidence: String(inp.oneRecBottleneck).slice(0, 120),
      layer: "auto",
    });
    pushI({
      id: "i_one_rec",
      for_missing: "one_rec",
      how: "止まった段の verify 印が出るまで同じ客で再走（one-rec-learn-loop）",
      cost: "ext",
    });
  }

  const think_order = [
    "①把握: 画像連携・axes・弱所・kbのどれが欠けているか",
    "②足りない: missing を層（photo/flash/material/gate/ext/auto）で列挙",
    "③どう強化: strengthen（材料・flash・関所）を名指し",
    "④どう改善: improve（拡張読込・自動・効果）を名指し",
    "⑤細部: fine_atoms を欄×観点で1つずつ",
    "⑥仕組み: どんな仕組み（完了線付き）があれば改善されるか",
    "⑦構築: build_next で仕組みを作る（表示だけで終わらせない）",
    "⑧自動反映: 束→拡張再読込→自動1回→F31/F32/F43で測る",
    "⑨仮定と100%への道: 数字の無い物は仮定と明記／path_to_100",
    "⑩手配: 人／拡張／学習のどれが何をするか順に書く",
  ];

  const bottleneck = missing[0]
    ? `${missing[0].what}（${missing[0].evidence}）`
    : (imageDone === true ? null : imageLine);

  const scaffold = [
    `画像学習: ${imageLine}`,
    `足りない${missing.length}: ${missing.slice(0, 4).map((m) => m.what).join("／") || "大きな欠なし"}`,
    `強化: ${strengthen.slice(0, 3).map((h) => h.how).join("／") || "—"}`,
    `改善: ${improve.slice(0, 3).map((h) => h.how).join("／") || "—"}`,
    `細部原子${fine.length}: ${fine.slice(0, 4).map((a) => a.field).join("・") || "—"}`,
  ].join(" ｜ ");

  const line = bottleneck
    ? `Pro思考骨格: 止=${bottleneck}／欠${missing.length}／強化${strengthen.length}／改善${improve.length}／細部${fine.length}`
    : `Pro思考骨格: 欠なし（画像${imageDone === true ? "✓" : "?"}）細部${fine.length}`;

  return {
    think_order,
    missing: missing.slice(0, 10),
    strengthen: strengthen.slice(0, 10),
    improve: improve.slice(0, 10),
    fine_atoms: fine.slice(0, 12),
    image_learn: {
      done: imageDone,
      line: imageLine,
      gaps: imageGaps.slice(0, 8),
    },
    bottleneck,
    line,
    scaffold: scaffold.slice(0, 600),
  };
}
