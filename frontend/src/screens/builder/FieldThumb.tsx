import type { ReactNode } from "react";
import type { FieldType } from "@/lib/formEngine";

/**
 * A small picture of each field type for the builder's palette: what the
 * field looks like once it's on the form, drawn in theme tokens so it reads
 * in light and dark.
 */

/** Plain-language one-liners for the palette (FIELD_TYPES' descriptions are written for the JSON). */
export const FIELD_BLURBS: Record<FieldType, string> = {
  text: "Short text: a name, an ID, a one-line answer.",
  textarea: "Longer, multi-line text like notes or descriptions.",
  number: "Numbers only, with optional min, max and step.",
  email: "An email address, checked for the right shape.",
  phone: "A phone number.",
  url: "A web address starting with https://.",
  date: "Pick a day from a calendar.",
  time: "Pick a time of day.",
  hidden: "Stored with the entry but never shown to the person filling it in.",
  select: "Pick one option from a compact list.",
  multiselect: "Pick several options from a list; they show as chips.",
  radio: "Pick one option, with all choices visible.",
  checkbox: "Tick any number of options.",
  consent: "A single required tick box with agreement text.",
  likert: "Rate several statements on the same scale.",
  name: "First and last name side by side.",
  address: "Street, city, state and ZIP in one block.",
  file: "Attach photos or documents.",
  signature: "Sign with a finger, mouse or pen.",
  rating: "A quick star score.",
  slider: "Drag to choose a value in a range.",
  repeater: "A group of fields that can be added again and again.",
  calculation: "A read-only value worked out from other fields.",
  site: "Choose one of the Lantern sites.",
  resident: "Search and pick a resident from a site's roster.",
  section: "A heading and divider that groups the fields below it.",
  html: "Instructions or other text, with no answer.",
  page: "Splits the form into steps.",
  code: "Your own HTML, CSS and JavaScript block.",
};

// Shorthands: label bar, input box, a line of "typed" text.
const Label = ({ x = 8, w = 28 }: { x?: number; w?: number }) => <rect className="fill-strongline" x={x} y={5} width={w} height={4} rx={2} />;
const Box = ({ x = 8.5, y = 13.5, w = 87, h = 20, className = "fill-surface" }: { x?: number; y?: number; w?: number; h?: number; className?: string }) => (
  <rect className={`${className} stroke-strongline`} x={x} y={y} width={w} height={h} rx={4} />
);
const Line = ({ x, y = 21.5, w, h = 4, className = "fill-ink" }: { x: number; y?: number; w: number; h?: number; className?: string }) => (
  <rect className={className} x={x} y={y} width={w} height={h} rx={h / 2} />
);
const Chevron = () => <path className="fill-none stroke-ink" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" d="M81 21.5l4 4 4-4" />;
const STAR = "0,-6 1.76,-2.43 5.71,-1.85 2.85,0.93 3.53,4.85 0,3 -3.53,4.85 -2.85,0.93 -5.71,-1.85 -1.76,-2.43";
const Check = ({ x, y }: { x: number; y: number }) => (
  <path className="fill-none stroke-surface" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" d={`M${x} ${y}l1.7 1.7 3-3.3`} />
);
const accent = "fill-status-blueDot";
const accentStroke = "fill-none stroke-status-blueDot";
const tint = "fill-status-blueBg";

const THUMBS: Record<FieldType, ReactNode> = {
  text: <><Label /><Box /><Line x={14} w={30} /><rect className={accent} x={47} y={18} width={1.5} height={11} /></>,
  textarea: (
    <>
      <rect className="fill-strongline" x={8} y={4} width={28} height={4} rx={2} />
      <Box y={11.5} h={29} />
      <Line x={14} y={17} w={66} h={3} className="fill-ink opacity-75" />
      <Line x={14} y={23} w={72} h={3} className="fill-ink opacity-75" />
      <Line x={14} y={29} w={40} h={3} className="fill-ink opacity-75" />
    </>
  ),
  number: (
    <>
      <Label /><Box />
      <text className="fill-ink" x={14} y={27.5} fontSize={11} fontWeight={700}>42</text>
      <path className="stroke-strongline" d="M80.5 14v19" />
      <path className="fill-none stroke-ink" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" d="M85 21.5l3-3 3 3M85 25.5l3 3 3-3" />
    </>
  ),
  email: <><Label /><Box /><text className={accent} x={13} y={27.5} fontSize={11} fontWeight={700}>@</text><Line x={27} w={44} /></>,
  phone: (
    <>
      <Label /><Box />
      <rect className={accentStroke} strokeWidth={1.4} x={14} y={17.5} width={7.5} height={12} rx={1.8} />
      <Line x={27} w={11} /><Line x={41} w={13} /><Line x={57} w={17} />
    </>
  ),
  url: (
    <>
      <Label /><Box />
      <g className={accentStroke} strokeWidth={1.3}><circle cx={18.5} cy={23.5} r={5} /><ellipse cx={18.5} cy={23.5} rx={2.2} ry={5} /><path d="M13.5 23.5h10" /></g>
      <Line x={28} w={46} />
    </>
  ),
  date: (
    <>
      <Label /><Box />
      <text className="fill-ink" x={14} y={27} fontSize={9} fontWeight={700}>09 / 29</text>
      <g className="fill-none stroke-ink" strokeWidth={1.3} strokeLinecap="round"><rect x={77.5} y={17.5} width={12} height={11} rx={2} /><path d="M77.5 21.5h12M80.5 16v3M86.5 16v3" /></g>
      <rect className={accent} x={80} y={23.5} width={3} height={3} rx={0.6} />
    </>
  ),
  time: (
    <>
      <Label /><Box />
      <text className="fill-ink" x={14} y={27} fontSize={9} fontWeight={700}>1:13 PM</text>
      <circle className="fill-none stroke-ink" strokeWidth={1.3} cx={83.5} cy={23.5} r={5.5} />
      <path className={accentStroke} strokeWidth={1.4} strokeLinecap="round" d="M83.5 20.5v3l2.2 1.6" />
    </>
  ),
  hidden: (
    <>
      <rect className="fill-none stroke-strongline" x={8.5} y={7.5} width={87} height={29} rx={4} strokeDasharray="3 3" />
      <g className="fill-none stroke-muted" strokeWidth={1.3} strokeLinecap="round"><path d="M40 22c7-7 17-7 24 0-7 7-17 7-24 0z" /><circle cx={52} cy={22} r={3} /><path d="M42 31L62 13" /></g>
    </>
  ),
  select: <><Label /><Box /><Line x={14} w={38} /><Chevron /></>,
  multiselect: (
    <>
      <Label /><Box />
      <rect className={tint} x={13} y={18.5} width={25} height={10} rx={5} /><Line x={17} y={22} w={12} h={3} className={accent} />
      <rect className={tint} x={41} y={18.5} width={25} height={10} rx={5} /><Line x={45} y={22} w={12} h={3} className={accent} />
      <Chevron />
    </>
  ),
  radio: (
    <>
      <circle className="fill-surface stroke-status-blueDot" strokeWidth={1.3} cx={15} cy={10} r={4.5} /><circle className={accent} cx={15} cy={10} r={2.3} /><Line x={25} y={8} w={40} />
      <circle className="fill-surface stroke-strongline" cx={15} cy={22} r={4.5} /><Line x={25} y={20} w={32} className="fill-ink opacity-60" />
      <circle className="fill-surface stroke-strongline" cx={15} cy={34} r={4.5} /><Line x={25} y={32} w={46} className="fill-ink opacity-60" />
    </>
  ),
  checkbox: (
    <>
      <rect className={accent} x={10.5} y={5.5} width={9} height={9} rx={2} /><Check x={12.8} y={10} /><Line x={25} y={8} w={40} />
      <rect className={accent} x={10.5} y={17.5} width={9} height={9} rx={2} /><Check x={12.8} y={22} /><Line x={25} y={20} w={32} />
      <rect className="fill-surface stroke-strongline" x={10.5} y={29.5} width={9} height={9} rx={2} /><Line x={25} y={32} w={46} className="fill-ink opacity-60" />
    </>
  ),
  consent: (
    <>
      <rect className={accent} x={9.5} y={8.5} width={11} height={11} rx={2.2} /><Check x={12.3} y={14} />
      <Line x={27} y={9} w={62} h={3} className="fill-muted" /><Line x={27} y={16} w={54} h={3} className="fill-muted" />
      <Line x={27} y={23} w={30} h={3} className="fill-muted" /><Line x={60} y={23} w={26} h={3} className={accent} />
    </>
  ),
  likert: (
    <>
      {[12, 22, 32].map((y, r) => (
        <g key={y}>
          <Line x={8} y={y - 2} w={[20, 16, 22][r]} className="fill-ink opacity-70" />
          {[42, 54, 66, 78, 90].map((x, c) => (
            <circle key={x} className={c === [1, 3, 2][r] ? accent : "fill-none stroke-strongline"} cx={x} cy={y} r={3.5} />
          ))}
        </g>
      ))}
    </>
  ),
  name: (
    <>
      <Label w={18} /><Label x={56} w={18} />
      <Box w={40} /><Box x={55.5} w={40} />
      <Line x={14} w={22} /><Line x={61} w={26} />
    </>
  ),
  address: (
    <>
      <Box y={4.5} h={15} /><Line x={14} y={10} w={48} />
      <Box y={24.5} w={50} h={15} /><Line x={14} y={30} w={28} className="fill-ink opacity-60" />
      <Box x={63.5} y={24.5} w={14} h={15} /><Box x={81.5} y={24.5} w={14} h={15} />
    </>
  ),
  file: (
    <>
      <rect className="fill-surface stroke-status-blueDot" x={8.5} y={4.5} width={87} height={35} rx={6} strokeDasharray="3 3" />
      <path className={accentStroke} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" d="M52 26V13M46.5 18L52 12.5l5.5 5.5" />
      <Line x={38} y={30} w={28} h={3} className="fill-muted" />
    </>
  ),
  signature: (
    <>
      <Box y={5.5} h={33} />
      <path className="stroke-strongline" d="M14 31.5h76" />
      <path className="stroke-muted" strokeWidth={1.2} strokeLinecap="round" d="M14.5 25l3 3M17.5 25l-3 3" />
      <path className="fill-none stroke-ink" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" d="M24 28c4-15 9-15 7-3s6-11 9-4 5 7 9-2c3-6 5 2 9-1s6-4 10 0 5 1 9-2" />
    </>
  ),
  rating: (
    <>
      {[20, 36, 52, 68, 84].map((x, i) => (
        <polygon key={x} transform={`translate(${x} 22) scale(1.35)`} points={STAR} className={i < 3 ? accent : "fill-surface stroke-strongline"} strokeWidth={0.8} />
      ))}
    </>
  ),
  slider: (
    <>
      <rect className="fill-subtle2" x={10} y={27} width={84} height={4} rx={2} />
      <rect className={accent} x={10} y={27} width={52} height={4} rx={2} />
      <circle className="fill-surface stroke-status-blueDot" strokeWidth={2} cx={62} cy={29} r={6} />
      <rect className="fill-navy" x={52} y={5} width={20} height={12} rx={3} />
      <text className="fill-white" x={62} y={13.8} textAnchor="middle" fontSize={7.5} fontWeight={700}>60</text>
    </>
  ),
  repeater: (
    <>
      {[3.5, 18.5].map((y, i) => (
        <g key={y}>
          <Box y={y} h={12} />
          <text className="fill-muted" x={13} y={y + 8.5} fontSize={7} fontWeight={700}>{i + 1}</text>
          <Line x={21} y={y + 4.5} w={[30, 26][i]} h={3} className="fill-ink opacity-70" />
          <Line x={56} y={y + 4.5} w={[24, 30][i]} h={3} className="fill-ink opacity-70" />
        </g>
      ))}
      <rect className={tint} x={8.5} y={33.5} width={30} height={9} rx={4.5} />
      <path className={accentStroke} strokeWidth={1.4} strokeLinecap="round" d="M14 38h4M16 36v4" />
      <Line x={21} y={36.5} w={12} h={3} className={accent} />
    </>
  ),
  calculation: (
    <>
      <Label /><Box className="fill-subtle" />
      <text className="fill-ink" x={14} y={27.5} fontSize={10.5} fontWeight={700}>= 128</text>
      <rect className={tint} x={73} y={17.5} width={18} height={12} rx={3} />
      <text className={accent} x={82} y={26.3} textAnchor="middle" fontSize={8} fontStyle="italic" fontWeight={700} fontFamily="Georgia, serif">fx</text>
    </>
  ),
  site: (
    <>
      <Label /><Box />
      <path className={accentStroke} strokeWidth={1.4} d="M15.5 21.5a4 4 0 0 1 8 0c0 3.8-4 7.5-4 7.5s-4-3.7-4-7.5z" />
      <circle className={accent} cx={19.5} cy={21.5} r={1.3} />
      <Line x={29} w={40} /><Chevron />
    </>
  ),
  resident: (
    <>
      <Label /><Box />
      <circle className={tint} cx={19} cy={23.5} r={6} /><circle className={accent} cx={19} cy={21.8} r={2} />
      <path className={accent} d="M15.2 27.6a3.9 3.9 0 0 1 7.6 0z" />
      <Line x={29} w={38} />
      <g className="fill-none stroke-ink" strokeWidth={1.3} strokeLinecap="round"><circle cx={83} cy={22.5} r={3.5} /><path d="M85.6 25.1l2.6 2.6" /></g>
    </>
  ),
  section: (
    <>
      <rect className="fill-ink" x={8} y={6} width={50} height={7} rx={2} />
      <Line x={8} y={17} w={70} h={3} className="fill-strongline" />
      <path className="stroke-ink" strokeWidth={1.5} d="M8 25.5h88" />
      <Line x={8} y={31} w={80} h={3} className="fill-subtle2" />
      <Line x={8} y={37} w={60} h={3} className="fill-subtle2" />
    </>
  ),
  html: (
    <>
      <rect className="fill-ink" x={8} y={6} width={30} height={5} rx={2} />
      {[88, 82, 86, 50].map((w, i) => <Line key={i} x={8} y={16 + i * 6} w={w} h={3} className="fill-muted" />)}
    </>
  ),
  page: (
    <>
      <rect className="fill-surface stroke-strongline" x={16.5} y={-4.5} width={71} height={16} rx={3} />
      <rect className="fill-surface stroke-strongline" x={16.5} y={32.5} width={71} height={16} rx={3} />
      <path className="stroke-status-blueDot" strokeWidth={1.3} strokeDasharray="3 3" d="M4 22h96" />
      <rect className={accent} x={36} y={16} width={32} height={12} rx={6} />
      <text className="fill-white" x={52} y={24.4} textAnchor="middle" fontSize={7} fontWeight={700}>Page 2</text>
    </>
  ),
  code: (
    <>
      <rect className="fill-navy" x={8.5} y={5.5} width={87} height={33} rx={5} />
      <text x={14} y={18} fontSize={9} fontWeight={600} fill="#9db2ff" fontFamily="ui-monospace, monospace">&lt;/&gt;</text>
      <rect x={36} y={12} width={34} height={3} rx={1.5} fill="#6b7aa3" />
      <rect x={14} y={24} width={50} height={3} rx={1.5} fill="#6b7aa3" />
      <rect x={20} y={30} width={36} height={3} rx={1.5} fill="#8d9bc6" />
    </>
  ),
};

export function FieldThumb({ type }: { type: FieldType }) {
  return (
    <svg viewBox="0 0 104 44" className="block h-12 w-full" aria-hidden focusable="false">
      {THUMBS[type] ?? <><Label /><Box /></>}
    </svg>
  );
}
