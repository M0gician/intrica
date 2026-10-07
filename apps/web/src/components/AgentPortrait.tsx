import {
  cameoPortrait,
  PORTRAIT_SKINS,
  portraitColors,
  portraitTraits,
  portraitVariant,
} from "@intrica/contracts";
import { tr, useTranslation } from "../i18n";
/** Persisted, independently varied features; uploaded photos take precedence. */
export function AgentPortrait({
  id,
  assetId,
  variant,
  name,
}: {
  id: string;
  name?: string | undefined;
  assetId?: string;
  variant?: number | undefined;
}) {
  useTranslation();

  if (assetId)
    return (
      <img
        className="agent-portrait"
        src={`/api/v2/assets/${encodeURIComponent(assetId)}?variant=thumb`}
        alt={tr("Agent 肖像")}
      />
    );
  const value = portraitVariant(id, variant);
  const character = cameoPortrait(name);
  const traits = { ...portraitTraits(value), ...character };
  const expression = character?.name === "王大锤" ? 1 : Math.floor(value / 7) % 4;
  const faceWidth = 36 + (Math.floor(value / 11) % 3) * 3;
  const bg = ["#cbdcda", "#d9d7ea", "#e8d8c6", "#d2dfcc", "#e6d0ce", "#cddbea"][traits.background];
  const skin = PORTRAIT_SKINS[traits.skin]!;
  const colors = portraitColors(skin);
  const hair = ["#29272b", "#423b39", "#7c5238", "#c5a275", "#e3ded3", "#805149"][traits.hair];
  const coat = ["#466a67", "#625673", "#405a73", "#4e6050", "#805950", "#504b46", "#b28a3e"][
    traits.coat
  ];
  const hairstyles = [
    "M57 71q-2-52 44-51 47 0 44 58-13-20-24-33-21 27-64 26",
    "M57 79q-9-57 37-60 53-5 51 55-33-8-37-31-12 33-51 36",
    "M56 82V50q2-32 44-32t44 32v32l-14-27-60 2z",
    "M55 82q-10-26 3-40-3-23 19-23 13-18 30-5 26-10 34 16 18 13 4 47l-17-26q-27 12-59 0z",
    "M58 67q-3-45 42-45t43 45l-9-20q-34-17-68 0z",
    "M55 83q-8-64 43-64 52 0 48 68l-12-26-7-17-9 24-20-16-17 20-12-13z",
  ];
  return (
    <svg
      data-portrait-variant={value}
      data-character={character?.name}
      className="agent-portrait"
      viewBox="0 0 200 200"
      role="img"
      aria-label={tr("Agent 人物肖像")}
    >
      <rect width="200" height="200" fill={bg} />
      <circle cx="165" cy="28" r="82" fill="#fff" opacity=".16" />
      <path d="M24 208q5-66 59-70h34q54 3 61 70" fill={coat} />
      <path d="M80 130v25l20 16 20-16v-25" fill={skin} />
      {character?.name !== "王大锤" && (character || value % 4 !== 3) && (
        <path d="M76 145l24 27-18 23-21-45m63-5l-24 27 18 23 21-45" fill="#fff" opacity=".85" />
      )}
      {traits.hairStyle === 1 || character?.name === "赫敏" ? (
        <path d="M53 129V67q0-48 47-48t47 48v62q-8 21-28 24H81q-20-3-28-24" fill={hair} />
      ) : (
        <ellipse cx="100" cy="67" rx="45" ry="49" fill={hair} />
      )}
      <ellipse cx="100" cy="87" rx={faceWidth} ry="52" fill={skin} />
      <ellipse cx={100 - faceWidth} cy="94" rx="6" ry="10" fill={skin} />
      <ellipse cx={100 + faceWidth} cy="94" rx="6" ry="10" fill={skin} />
      <path d={hairstyles[traits.hairStyle]} fill={hair} />
      <path
        data-feature="brows"
        d="M76 82q8-3 15-1m18 0q8-2 15 1"
        fill="none"
        stroke={colors.brow}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <g data-feature="eyes">
        {[83, 117].map((x) => (
          <g key={x}>
            <path d={`M${x - 6} 92q6-6 12 0-6 5-12 0`} fill={colors.eyeWhite} />
            <ellipse cx={x} cy="91.5" rx="2.3" ry="2.8" fill={colors.pupil} />
            <path
              d={`M${x - 6} 91.5q6-4 12 0`}
              fill="none"
              stroke={colors.brow}
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </g>
        ))}
      </g>
      <g data-feature="nose" fill="none" strokeLinecap="round">
        <path d="M101 97q-2 5-2 8" stroke={colors.noseLight} strokeWidth="2" />
        <path d="M98 106q3 3 7 0" stroke={colors.nose} strokeWidth="1.7" />
      </g>
      <g data-feature="mouth" strokeLinecap="round">
        <path
          d={
            [
              "M91 120q9 5 18-1",
              "M93 120q7 1 14 0",
              "M92 120q8 3 17-2",
              "M91 119q9 4 18 0-2 7-9 7t-9-7",
            ][expression]
          }
          fill={expression === 3 ? colors.mouth : "none"}
          stroke={colors.mouth}
          strokeWidth="1.5"
        />
        {expression !== 3 && (
          <path d="M96 124q5 1 9-1" fill="none" stroke={colors.lip} strokeWidth="1.4" />
        )}
      </g>
      {(character?.beard || (!character && value % 9 === 0)) && (
        <path
          d={
            character?.beard === "long"
              ? "M68 116q10 13 22 11h20q12-1 22-11l-6 34-26 39-26-39z"
              : character?.beard === "pointed"
                ? "M77 113q12-9 23 0 12-9 23 0l-16 7-7-4-7 4z"
                : "M82 113q9-7 18-1 9-6 18 1l-5 5-13-3-13 3z"
          }
          fill={hair}
        />
      )}
      {character?.mark && <path d="M104 69a8 8 0 1 1-9-12 7 7 0 0 0 9 12" fill="#dfcbae" />}
      {(character?.accessory === "bow" || (!character && value % 4 === 0)) && (
        <path d="M82 161l18 6 18-6v18l-18-6-18 6z" fill="#9f4845" />
      )}
      {((character?.accessory === "tie" && character.name !== "王大锤") ||
        (!character && value % 4 === 1)) && <path d="M96 165h8l3 10-7 22-7-22z" fill="#a88760" />}
      {(character?.accessory === "scarf" || (!character && value % 4 === 2)) && (
        <g fill="#964d48">
          <path d="M75 148q25 17 50 0l-2 13q-23 13-46 0z" />
          <path d="M107 164l13-4 13 36h-19z" />
        </g>
      )}
      {character?.accessory === "cap" && (
        <g fill="#766047" stroke="#554938" strokeWidth="2">
          <path d="M51 51q0-32 49-32 47 0 49 32l-14 7H65z" />
          <path d="M43 54q58-19 114 0l-7 8q-50-11-100 0z" />
          <path d="M100 20v30M78 24l-7 28m49-28 9 28" fill="none" />
        </g>
      )}
      {character?.accessory === "bowler" && (
        <g fill="#373531">
          <path d="M65 46V30q4-22 35-22t35 22v16z" />
          <ellipse cx="100" cy="48" rx="53" ry="8" />
          <path d="M65 39h70v7H65" fill="#80624a" />
        </g>
      )}
      {character?.accessory === "official" && (
        <g fill="#333238">
          <path d="M60 45V23q40-22 80 0v22zM60 29L10 21v13l50 8m80-13 50-8v13l-50 8" />
          <circle cx="100" cy="32" r="5" fill="#b6a178" />
        </g>
      )}
      {character?.accessory === "crown" && (
        <path
          d="M74 46l-7-24 18 4 4-22h22l4 22 18-4-7 24z"
          fill="#474b48"
          stroke="#b6a178"
          strokeWidth="3"
        />
      )}
      {character?.accessory === "wizard" && (
        <g fill="#888c89" stroke="#666d6b" strokeWidth="2">
          <path d="M54 51L107 3l34 48z" />
          <ellipse cx="100" cy="52" rx="64" ry="7" />
        </g>
      )}
      {traits.glasses !== 0 && (
        <g data-feature="glasses" fill="none" stroke={colors.frame} strokeWidth="1.8">
          <rect
            x="70"
            y="84"
            width="25"
            height="17"
            rx={traits.glasses === 1 ? 6 : traits.glasses === 2 ? 10 : 1}
          />
          <rect
            x="105"
            y="84"
            width="25"
            height="17"
            rx={traits.glasses === 1 ? 6 : traits.glasses === 2 ? 10 : 1}
          />
          <path d="M95 89h10" />
        </g>
      )}
    </svg>
  );
}
