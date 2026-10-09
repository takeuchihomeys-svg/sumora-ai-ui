// app/lib/staff-device.ts — 送った端末の印（2026-10-08 竹内「端末で分析して竹内か従業員か判断できてるのかな？」）
//   アプリにスタッフのログインが無い（INTERNAL_API_SECRET は全員同じ）ので、ブラウザごとに1つの端末 ID を作って送信の API に添える。
//   端末 → 書き手（竹内さん／従業員）は staff_devices.writer に1回だけ付ける（同じ端末の送信は以後ずっとその人）。
//   画面（ブラウザ）からも、サーバからも import できる純関数＋ブラウザだけの関数（window が無ければ何もしない）。

export const STAFF_DEVICE_HEADER = "x-staff-device";
const STORAGE_KEY = "sumora_staff_device_id";
const ID_RE = /^[0-9a-zA-Z_-]{8,64}$/;

/** User-Agent を短い端末名にする（例 "iPhone iOS18.7 Safari26.6.1"・"Windows Chrome154"）。IP は持たない */
export function deviceLabelOf(ua: string | null | undefined): string {
  const s = String(ua ?? "");
  if (!s) return "不明";
  const ios = s.match(/iPhone OS ([0-9_]+)/)?.[1]?.replace(/_/g, ".");
  const android = s.match(/Android ([0-9.]+)/)?.[1];
  const os = ios ? `iPhone iOS${ios}` : android ? `Android${android}` : /Windows/.test(s) ? "Windows" : /Mac OS X/.test(s) ? "Mac" : "その他";
  const app = s.match(/Line\/([0-9.]+)/)?.[1] ? `LINE${s.match(/Line\/([0-9.]+)/)![1]}`
    : s.match(/CriOS\/([0-9]+)/)?.[1] ? `Chrome${s.match(/CriOS\/([0-9]+)/)![1]}`
    : s.match(/Edg\/([0-9]+)/)?.[1] ? `Edge${s.match(/Edg\/([0-9]+)/)![1]}`
    : s.match(/Chrome\/([0-9]+)/)?.[1] ? `Chrome${s.match(/Chrome\/([0-9]+)/)![1]}`
    : s.match(/Version\/([0-9.]+)[^]*Safari/)?.[1] ? `Safari${s.match(/Version\/([0-9.]+)/)![1]}`
    : s === "node" || /^node/.test(s) ? "server" : "";
  return `${os}${app ? ` ${app}` : ""}`;
}

/** ヘッダの端末 ID を確かめる（形が違えば null） */
export function parseStaffDeviceId(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  return ID_RE.test(s) ? s : null;
}

/** ブラウザの端末 ID（無ければ作って localStorage に残す）。サーバ・保存できない時は null */
export function getStaffDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const cur = parseStaffDeviceId(window.localStorage.getItem(STORAGE_KEY));
    if (cur) return cur;
    const id = (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).replace(/[^0-9a-zA-Z_-]/g, "");
    window.localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/** 送信の API に添えるヘッダ（NEXT_PUBLIC_STAFF_DEVICE_HEADER=off で添えない） */
export function staffDeviceHeader(): Record<string, string> {
  if ((process.env.NEXT_PUBLIC_STAFF_DEVICE_HEADER ?? "on").toLowerCase() === "off") return {};
  const id = getStaffDeviceId();
  return id ? { [STAFF_DEVICE_HEADER]: id } : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-08 竹内さんの決定11「管理者とスタッフにする」: 書き手の呼び方は画面では「管理者（竹内さん）」「スタッフ（従業員）」。
//   中の値は今の 'takeuchi'／'employee' のまま（表示だけ）。新しい端末で印が無ければ画面の小さな欄で選び、staff_devices.writer に入れる。
// ─────────────────────────────────────────────────────────────────────────────
export type DeviceWriter = "takeuchi" | "employee";
export const DEVICE_WRITERS: readonly DeviceWriter[] = ["takeuchi", "employee"];
export const DEVICE_WRITER_JA: Record<DeviceWriter, string> = { takeuchi: "管理者（竹内さん）", employee: "スタッフ（従業員）" };

export function parseDeviceWriter(v: unknown): DeviceWriter | null {
  return v === "takeuchi" || v === "employee" ? v : null;
}
export function deviceWriterLabel(v: unknown): string {
  const w = parseDeviceWriter(v);
  return w ? DEVICE_WRITER_JA[w] : "未設定";
}

/** 端末の印を選ぶ欄を出すか（端末 ID があり・まだ印が無く・この端末で「後で」を押していない）。戻す: NEXT_PUBLIC_STAFF_DEVICE_PROMPT=off */
export function shouldAskDeviceWriter(o: { deviceId: string | null; writer: unknown; dismissedAt?: string | null; nowMs?: number; envFlag?: string | undefined }): boolean {
  if ((o.envFlag ?? "").trim().toLowerCase() === "off") return false;
  if (!o.deviceId || parseDeviceWriter(o.writer)) return false;
  // 「後で」は12時間だけ出さない（毎回の読み込みで邪魔をしない・忘れたままにもしない）
  const d = o.dismissedAt ? Date.parse(o.dismissedAt) : NaN;
  if (Number.isFinite(d) && (o.nowMs ?? Date.now()) - d < 12 * 3600_000) return false;
  return true;
}
