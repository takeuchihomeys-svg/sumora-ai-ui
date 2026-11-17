/**
 * 画像学習 ↔ 統括Pro の細かい連携（2026-11-16）
 *
 * ★ 竹内さん「画像学習の部分の連携もちゃんとできるように
 *   画像よみとりのflashとproのまとめる部分で判断ちゃんとできるように
 *   細かい部分も連携できるようにする／ちゃんと統括できるように
 *   細かい部分のつなぐのも徹底して細分化して強化する」:
 *
 *   【役割を混ぜない】
 *     flash … 画像を読む（Vision・shot_learn）
 *     材料 … 欄の種類・位置・突き合わせ（束・決定論の根拠）
 *     Pro   … 材料で判断する（足りない土台・次手）
 *     関所 … verdict / photo_learn の kind・limit（決定論）
 *
 *   ⚠ 学習→自動の一連（bundle-reflect 1〜5）とは別軸。
 *     こちらは「画像を読んで統括が判断できるまで」のつなぎ。
 */
import { SHOT_LEARN_DEFAULT_MODEL } from "./shot-learn-limit";

/** Pro まとめの既定（learn-supervisor-pro と揃える・循環import回避） */
const PRO_MODEL_DEFAULT = "deepseek-v4-pro";

export type VisionProRole = "flash" | "material" | "gate" | "pro" | "reflect";

export type VisionProStep = {
  n: number;
  name: string;
  ok: boolean;
  detail: string;
  role: VisionProRole;
};

export type VisionProLink = {
  steps: VisionProStep[];
  bottleneck_n: number | null;
  bottleneck: string | null;
  line: string;
  /** 統括・Pro が使う短い数字 */
  counts: {
    photo_in_storage: number;
    learned_ok: number;
    todo: number;
    photo_kinds_n: number;
    image_fields: number;
    with_screen_pos: number;
    matched: number;
    has_photo_learn_task: boolean;
    used_pro: boolean | null;
  };
  roles: {
    flash_model: string;
    pro_model: string;
  };
};

export type VisionProLinkInput = {
  photoInStorage?: number | null;
  /** flash で読んで shot_learn が埋まった枚数（learnedOk） */
  learnedOk?: number | null;
  /** まだ読める未学習 */
  todo?: number | null;
  /** 写真から読んだ欄の種類の件数合計 */
  photoKindsN?: number | null;
  /** 画像から取れた欄名の数 */
  imageFields?: number | null;
  /** x/y がある欄 */
  withScreenPos?: number | null;
  /** 画像×押した位置が両方ある欄 */
  matched?: number | null;
  /** 決定論が photo_learn 課題を出しているか */
  hasPhotoLearnTask?: boolean | null;
  /** Pro まとめ済みか（未実行は null） */
  usedPro?: boolean | null;
  flashModel?: string | null;
  proModel?: string | null;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/**
 * 画像flash → 材料 → 関所課題 → Pro判断 の細分化連携。
 *
 *   1. 写真保存
 *   2. flashで読む（shot_learn）
 *   3. 材料が統括に届く（種類）
 *   4. 画像×位置の突き合わせ
 *   5. 未読があれば photo_learn 課題
 *   6. Proまとめ判断
 */
export function buildVisionProLink(opt: VisionProLinkInput = {}): VisionProLink {
  const photo = n(opt.photoInStorage);
  const learned = n(opt.learnedOk);
  const todo = n(opt.todo);
  const kindsN = n(opt.photoKindsN);
  const imageFields = n(opt.imageFields);
  const withPos = n(opt.withScreenPos);
  const matched = n(opt.matched);
  const hasPl = opt.hasPhotoLearnTask === true;
  const usedPro = opt.usedPro === true ? true : opt.usedPro === false ? false : null;
  const flashModel = String(opt.flashModel || SHOT_LEARN_DEFAULT_MODEL).slice(0, 40);
  const proModel = String(opt.proModel || PRO_MODEL_DEFAULT).slice(0, 40);

  const steps: VisionProStep[] = [
    {
      n: 1,
      name: "写真保存",
      ok: photo > 0,
      detail: photo > 0 ? `${photo}枚（Storage/shot_key）` : "写真が無い（読めない）",
      role: "flash",
    },
    {
      n: 2,
      name: "flashで読む",
      ok: learned > 0 || (photo === 0 && todo === 0),
      detail: learned > 0
        ? `学べ済み ${learned}枚（model=${flashModel}）`
        : (todo > 0
          ? `未学習 ${todo}枚が残る → photo_learn（flash）が要る`
          : (photo > 0 ? "写真はあるが学べ済み0（flash未実行）" : "読む対象なし")),
      role: "flash",
    },
    {
      n: 3,
      name: "材料が統括に届く",
      ok: kindsN > 0 || imageFields > 0,
      detail: kindsN > 0 || imageFields > 0
        ? `種類合計 ${kindsN}／画像欄 ${imageFields}`
        : "写真から読んだ種類・欄が統括に届いていない",
      role: "material",
    },
    {
      n: 4,
      name: "画像×位置の突き合わせ",
      ok: matched > 0 || withPos > 0,
      detail: matched > 0
        ? `両方あり ${matched}欄／画面位置 ${withPos}`
        : (withPos > 0
          ? `画面位置 ${withPos}（押した位置との突合はまだ薄い）`
          : "画像の位置も押した位置との突合も無い"),
      role: "material",
    },
    {
      n: 5,
      name: "未読→photo_learn課題",
      ok: todo === 0 || hasPl,
      detail: todo === 0
        ? "読める未学習なし（課題不要）"
        : (hasPl
          ? `未学習 ${todo}枚 → photo_learn 課題あり（flashが読む）`
          : `未学習 ${todo}枚なのに photo_learn 課題が無い（統括が把握できていない）`),
      role: "gate",
    },
    {
      n: 6,
      name: "Proまとめ判断",
      // 保存前（null）はボトルネックにしない。false だけ穴。
      ok: usedPro !== false,
      detail: usedPro === true
        ? `Proまとめ済み（model=${proModel}）`
        : usedPro === false
          ? `Pro未使用（model=${proModel}）→ 決定論のみ`
          : `Proは保存時に実行予定（model=${proModel}）`,
      role: "pro",
    },
  ];

  const stuck = steps.find((s) => !s.ok) || null;
  const line = steps.map((s) => `${s.n}.${s.name}${s.ok ? "✓" : "✗"}`).join(" → ")
    + (stuck ? ` ／止: ${stuck.n}.${stuck.name}（${stuck.detail}）` : " ／画像→統括Pro連携OK");

  return {
    steps,
    bottleneck_n: stuck ? stuck.n : null,
    bottleneck: stuck ? `${stuck.n}.${stuck.name}: ${stuck.detail}` : null,
    line,
    counts: {
      photo_in_storage: photo,
      learned_ok: learned,
      todo,
      photo_kinds_n: kindsN,
      image_fields: imageFields,
      with_screen_pos: withPos,
      matched,
      has_photo_learn_task: hasPl,
      used_pro: usedPro,
    },
    roles: { flash_model: flashModel, pro_model: proModel },
  };
}

/** Pro 実行後に step6 だけ確定させた連携行を返す */
export function markVisionProUsed(link: VisionProLink, used: boolean, model?: string | null): VisionProLink {
  const proModel = String(model || link.roles.pro_model || PRO_MODEL_DEFAULT).slice(0, 40);
  const steps = link.steps.map((s) => {
    if (s.n !== 6) return s;
    return {
      ...s,
      ok: used,
      detail: used
        ? `Proまとめ済み（model=${proModel}）`
        : `Pro未使用（model=${proModel}）→ 決定論のみ`,
      role: "pro" as const,
    };
  });
  const stuck = steps.find((s) => !s.ok) || null;
  const line = steps.map((s) => `${s.n}.${s.name}${s.ok ? "✓" : "✗"}`).join(" → ")
    + (stuck ? ` ／止: ${stuck.n}.${stuck.name}（${stuck.detail}）` : " ／画像→統括Pro連携OK");
  return {
    ...link,
    steps,
    bottleneck_n: stuck ? stuck.n : null,
    bottleneck: stuck ? `${stuck.n}.${stuck.name}: ${stuck.detail}` : null,
    line,
    counts: { ...link.counts, used_pro: used },
    roles: { ...link.roles, pro_model: proModel },
  };
}

/** evidence / Pro payload 用の短い1行 */
export function visionProLinkLine(link: VisionProLink): string {
  return link.line;
}
