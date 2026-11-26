/**
 * 人の動き・位置・操作ログ（human_motion_learn）から、
 * 1) DOM の破損名（#[object HTMLInputElement] 等）
 * 2) 他サイトの固有要素（リアプロ ↔ ITANDI の混入）
 * を送信時・受信時に自動除去するサニタイザ（純関数）。
 *
 * 根拠（2026-11-26 DB 実測）:
 *   - human_motion_learn #28319 (site=realpro, ext=2.8.309) に ITANDI 要素 #_r_5r_｜input.css-vm8hlm と #[object HTMLInputElement] が混入
 *   - human_motion_learn site=itandi 107件中11件にリアプロ要素 eq_rm[] / city_code[] / #top_free / #main_form 等が混入
 */

const GARBAGE_FIELD_RE = /^(?:#?\[object\s[^\]]*\]|undefined|null|\?|[-ー－_・=|/\\*~～]{2,}|input|select|textarea|button|span|div|label|iframe|id|form|table|tr|td|th|ul|li|body|html|img)$/i;

/** リアプロ固有の要素名・UI文言（site=itandi に入っていたら混入） */
const REALPRO_ONLY_FIELD_RE = new RegExp(
  [
    "^(?:eq_rm|city_code|town_code|route_id|station_id|room_layout_id|struct_id|exclusive_area)\\[",
    "^rental_cost[12]$",
    "^structured_date$",
    "^(?:transportation_id|required_time)$",
    "^deposit_recommpence",
    "^#(?:top_free|main_form)$",
    "駅の設定へ進む|沿線の設定へ戻る|確定してリストへ",
    "\\.(?:one_city|one_town|one_line|one_station|go_search)(?:[^a-zA-Z0-9_]|$)",
    "(?:沿線・駅絞り込み|所在地絞り込み)",
  ].join("|"),
);

/** ITANDI 固有の要素名・UI文言（site=realpro に入っていたら混入） */
const ITANDI_ONLY_FIELD_RE = new RegExp(
  [
    "^#?_r_[a-z0-9_]+_(?:｜|$)",
    "css-[a-z0-9]{4,}",
    "itandi-bb-ui",
    "^(?:rent|reikin|shikikin|room_layout|building_name|free_word|floor_area|floor_area_amount|station_walk_minutes|structure_type|option_id|offer_conditions_updated_at|building_age):(?:lteq|gteq|eq|in|match|not_eq)",
    "(?:小窓の確定|物件資料|募集中物確不要|路線・駅選択|^路線・駅で絞り込み|^物件情報・特徴)",
  ].join("|"),
  "i",
);

export function isAllowedMotionFieldName(name: unknown, site: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  const s = name.trim();
  if (!s) return false;
  if (GARBAGE_FIELD_RE.test(s) || /\[object\s+[A-Z]/i.test(s) || /路線・駅選択都道府県/.test(s)) return false;

  const sc = String(site || "").toLowerCase();
  if (sc === "realpro" && ITANDI_ONLY_FIELD_RE.test(s)) return false;
  if (sc === "itandi" && REALPRO_ONLY_FIELD_RE.test(s)) return false;
  return true;
}

/**
 * 既存の束（bundle）に古い蓄積・引き継ぎから混入したゴミ欄名・他サイト要素・爆発点（n > 5000 かつ 0.5,0.5）を取り除く。
 *   site が "realpro" / "itandi" 以外の時（"all" / null）もゴミ欄・爆発点は除去する。
 */
export function sanitizeBundleForSite(bundle: Record<string, unknown>, site?: string | null): {
  removed: number;
  samples: string[];
} {
  let removed = 0;
  const samples: string[] = [];
  const noteDrop = (name: unknown) => {
    removed++;
    const s = String(name ?? "").slice(0, 40);
    if (s && samples.length < 10 && !samples.includes(s)) samples.push(s);
  };
  const sc = (site === "realpro" || site === "itandi") ? site : null;

  if (bundle.points && typeof bundle.points === "object" && !Array.isArray(bundle.points)) {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bundle.points as Record<string, unknown>)) {
      if (!isAllowedMotionFieldName(k, sc)) { noteDrop(k); continue; }
      if (!v || typeof v !== "object") continue;
      const pv = v as Record<string, unknown>;
      const rawN = Number(pv.n) || 0;
      if (rawN > 5000 && pv.x === 0.5 && pv.y === 0.5) {
        noteDrop(`${k}(n=${rawN}@0.5)`);
        continue;
      }
      clean[k] = rawN > 500 ? { ...pv, n: 500 } : pv;
    }
    bundle.points = clean;
  }

  for (const mapKey of ["opens", "next", "cursor_hand"] as const) {
    const m = bundle[mapKey];
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        if (!isAllowedMotionFieldName(k, sc)) { noteDrop(k); continue; }
        clean[k] = v;
      }
      bundle[mapKey] = clean;
    }
  }

  if (Array.isArray(bundle.buttons)) {
    bundle.buttons = bundle.buttons.filter((b) => {
      const name = (b && typeof b === "object") ? (b as Record<string, unknown>).name : b;
      const ok = isAllowedMotionFieldName(name, sc);
      if (!ok) noteDrop(name);
      return ok;
    });
  }

  if (Array.isArray(bundle.weak)) {
    bundle.weak = bundle.weak.filter((w) => {
      if (!w || typeof w !== "object") return true;
      const name = (w as Record<string, unknown>).name;
      if (typeof name !== "string") return true;
      const ok = isAllowedMotionFieldName(name, sc);
      if (!ok) noteDrop(name);
      return ok;
    });
  }

  if (Array.isArray(bundle.challenge_missing_in_bundle)) {
    bundle.challenge_missing_in_bundle = bundle.challenge_missing_in_bundle.filter((x) => {
      const ok = isAllowedMotionFieldName(x, sc);
      if (!ok) noteDrop(x);
      return ok;
    });
  }

  if (bundle.shots && typeof bundle.shots === "object" && !Array.isArray(bundle.shots)) {
    const sh = bundle.shots as Record<string, unknown>;
    if (sh.learned && typeof sh.learned === "object" && !Array.isArray(sh.learned)) {
      const cleanLearned: Record<string, unknown> = {};
      for (const [screen, arr] of Object.entries(sh.learned as Record<string, unknown>)) {
        if (!Array.isArray(arr)) { cleanLearned[screen] = arr; continue; }
        cleanLearned[screen] = arr.filter((item) => {
          const nm = (item && typeof item === "object") ? (item as Record<string, unknown>).name : null;
          const ok = isAllowedMotionFieldName(nm, sc);
          if (!ok) noteDrop(nm);
          return ok;
        });
      }
      sh.learned = cleanLearned;
    }
  }

  // scene_flows[].steps からもサイト外ステップ・ゴミ文言（itandi 内のリアプロ文言、路線・駅選択都道府県北海 等）を除く
  if (Array.isArray(bundle.scene_flows)) {
    const cleanFlows: Array<Record<string, unknown>> = [];
    for (const sf of bundle.scene_flows as Array<Record<string, unknown>>) {
      if (!sf || typeof sf !== "object") continue;
      const steps = Array.isArray(sf.steps) ? sf.steps : [];
      const keptSteps = steps.filter((st) => {
        const s = String(st ?? "").trim();
        if (!s) return false;
        const ok = isAllowedMotionFieldName(s, sc);
        if (!ok) noteDrop(s);
        return ok;
      });
      if (!keptSteps.length) continue;
      cleanFlows.push({ ...sf, steps: keptSteps });
    }
    bundle.scene_flows = cleanFlows;
  }

  return { removed, samples };
}

export type SanitizeMotionInput = {
  site: string | null;
  fields: string[] | null;
  field_order: string[] | null;
  point_fields: Record<string, unknown> | null;
  opens: Record<string, unknown> | null;
  shot_ops: Array<Record<string, unknown>> | null;
};

export type SanitizeMotionResult = SanitizeMotionInput & {
  filtered_count: number;
  filtered_samples: string[];
};

export function sanitizeHumanMotionPayload(input: SanitizeMotionInput): SanitizeMotionResult {
  const samples: string[] = [];
  let filtered = 0;
  const recordDrop = (name: unknown) => {
    filtered++;
    const s = String(name ?? "").slice(0, 40);
    if (s && samples.length < 10 && !samples.includes(s)) samples.push(s);
  };

  const fields = Array.isArray(input.fields)
    ? input.fields.filter((f) => {
      const ok = isAllowedMotionFieldName(f, input.site);
      if (!ok) recordDrop(f);
      return ok;
    })
    : null;

  const field_order = Array.isArray(input.field_order)
    ? input.field_order.filter((f) => {
      const ok = isAllowedMotionFieldName(f, input.site);
      if (!ok) recordDrop(f);
      return ok;
    })
    : null;

  let point_fields: Record<string, unknown> | null = null;
  if (input.point_fields && typeof input.point_fields === "object" && !Array.isArray(input.point_fields)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.point_fields)) {
      if (isAllowedMotionFieldName(k, input.site)) out[k] = v;
      else recordDrop(k);
    }
    point_fields = Object.keys(out).length ? out : null;
  }

  let opens: Record<string, unknown> | null = null;
  if (input.opens && typeof input.opens === "object" && !Array.isArray(input.opens)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.opens)) {
      if (isAllowedMotionFieldName(k, input.site)) out[k] = v;
      else recordDrop(k);
    }
    opens = Object.keys(out).length ? out : null;
  }

  let shot_ops: Array<Record<string, unknown>> | null = null;
  if (Array.isArray(input.shot_ops)) {
    const out: Array<Record<string, unknown>> = [];
    for (const op of input.shot_ops) {
      if (op && typeof op.f === "string" && op.f && !isAllowedMotionFieldName(op.f, input.site)) {
        recordDrop(op.f);
        continue;
      }
      out.push(op);
    }
    shot_ops = out.length ? out : null;
  }

  return {
    site: input.site,
    fields: fields && fields.length ? fields : null,
    field_order: field_order && field_order.length ? field_order : null,
    point_fields,
    opens,
    shot_ops,
    filtered_count: filtered,
    filtered_samples: samples,
  };
}
