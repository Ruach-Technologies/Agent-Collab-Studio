import { useMemo, useRef, type KeyboardEvent } from "react";
import { AVATARS, AVATAR_GRID, AVATAR_IDS, fallbackAvatar, isAvatarId, type AvatarDef, type AvatarId } from "../lib/avatars";
import "./avatar.css";

interface Run { x: number; y: number; w: number; fill: string }

/** One rect per horizontal run of same-colour pixels. */
function toRuns(def: AvatarDef): Run[] {
  const runs: Run[] = [];
  def.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const fill = ch === undefined || ch === "." ? undefined : def.palette[ch];
      if (fill) runs.push({ x, y, w: end - x, fill });
      x = end;
    }
  });
  return runs;
}

const runCache = new Map<AvatarId, Run[]>();
function runsFor(id: AvatarId): Run[] {
  let runs = runCache.get(id);
  if (!runs) { runs = toRuns(AVATARS[id]); runCache.set(id, runs); }
  return runs;
}

/** Resolve a stored avatar id, falling back to a stable pick from the name. */
export function resolveAvatar(id: AvatarId | string | null | undefined, name: string): AvatarId {
  return isAvatarId(id) ? id : fallbackAvatar(name);
}

export function Avatar({ id, name, size = 32, title }: {
  id?: AvatarId | string | null; name: string; size?: number; title?: string;
}) {
  const resolved = resolveAvatar(id, name);
  return (
    <svg
      className="avatar"
      width={size}
      height={size}
      viewBox={`0 0 ${AVATAR_GRID} ${AVATAR_GRID}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title ?? name}
      data-avatar={resolved}
    >
      {runsFor(resolved).map((r) => <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />)}
    </svg>
  );
}

const COLS_HINT = 4;

export function AvatarPicker({ value, onChange, label = "Choose an avatar" }: {
  value: AvatarId; onChange: (id: AvatarId) => void; label?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = useMemo(() => Math.max(0, AVATAR_IDS.indexOf(value)), [value]);

  const move = (to: number) => {
    const n = AVATAR_IDS.length;
    const next = ((to % n) + n) % n;
    const id = AVATAR_IDS[next];
    if (!id) return;
    onChange(id);
    refs.current[next]?.focus();
  };

  // Rows follow the rendered grid, so Up/Down jump by however many columns fit.
  const columns = () => {
    const first = refs.current[0];
    if (!first) return COLS_HINT;
    const top = first.offsetTop;
    let n = 0;
    for (const el of refs.current) { if (el && el.offsetTop === top) n++; else break; }
    return n || COLS_HINT;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    switch (e.key) {
      case "ArrowRight": move(i + 1); break;
      case "ArrowLeft": move(i - 1); break;
      case "ArrowDown": move(i + columns()); break;
      case "ArrowUp": move(i - columns()); break;
      case "Home": move(0); break;
      case "End": move(AVATAR_IDS.length - 1); break;
      default: return;
    }
    e.preventDefault();
  };

  return (
    <div className="avatar-picker" role="radiogroup" aria-label={label}>
      {AVATAR_IDS.map((id, i) => {
        const checked = i === current;
        const def = AVATARS[id];
        return (
          <button
            key={id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={checked ? "avatar-option avatar-option-checked" : "avatar-option"}
            onClick={() => onChange(id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className="avatar-option-art" aria-hidden="true"><Avatar id={id} name={def.label} size={40} /></span>
            <span className="avatar-option-label">{def.label}</span>
          </button>
        );
      })}
    </div>
  );
}
