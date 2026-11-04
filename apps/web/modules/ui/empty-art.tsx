import { type ReactNode, useId } from 'react'

const TONES = { faint: 0.16, soft: 0.28, mid: 0.46, strong: 0.72 }
type Tone = keyof typeof TONES

const lineProps = (tone: Tone = 'mid', width = 1.25) => ({
  fill: 'none',
  stroke: 'currentColor',
  strokeOpacity: TONES[tone],
  strokeWidth: width,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

/** Every piece is drawn from the text color, so the art follows the theme and stays one color. */
function Art({ children }: { children: ReactNode }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  return (
    <svg viewBox="0 0 240 150" aria-hidden="true" className="h-auto w-full text-ink">
      <defs>
        <pattern id={`${id}dots`} width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="6" cy="6" r="0.8" fill="currentColor" />
        </pattern>
        <radialGradient id={`${id}fade`}>
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}mask`}>
          <ellipse cx="120" cy="75" rx="120" ry="75" fill={`url(#${id}fade)`} />
        </mask>
      </defs>
      <rect width="240" height="150" fill={`url(#${id}dots)`} mask={`url(#${id}mask)`} opacity="0.3" />
      {children}
    </svg>
  )
}

/** The opaque base lets a piece hide whatever sits behind it. */
function Solid({ d, tone = 'mid', dashed }: { d: string; tone?: Tone; dashed?: boolean }) {
  return (
    <>
      <path d={d} fill="var(--canvas)" />
      <path d={d} {...lineProps(tone)} fill="currentColor" fillOpacity={0.04} strokeDasharray={dashed ? '3 4' : undefined} />
    </>
  )
}

function Panel({
  x,
  y,
  w,
  h,
  r = 8,
  tone = 'mid',
  dashed,
}: {
  x: number
  y: number
  w: number
  h: number
  r?: number
  tone?: Tone
  dashed?: boolean
}) {
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx={r} fill="var(--canvas)" />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={r}
        {...lineProps(tone)}
        fill="currentColor"
        fillOpacity={0.04}
        strokeDasharray={dashed ? '3 4' : undefined}
      />
    </>
  )
}

function Bar({ x, y, w, h = 4, o = 0.18 }: { x: number; y: number; w: number; h?: number; o?: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill="currentColor" fillOpacity={o} />
}

function Dot({ cx, cy, r = 2, o = 0.3 }: { cx: number; cy: number; r?: number; o?: number }) {
  return <circle cx={cx} cy={cy} r={r} fill="currentColor" fillOpacity={o} />
}

function Badge({ cx, cy, r, children }: { cx: number; cy: number; r: number; children: ReactNode }) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill="var(--canvas)" />
      <circle cx={cx} cy={cy} r={r} {...lineProps('strong', 1.5)} fill="currentColor" fillOpacity={0.06} />
      {children}
    </>
  )
}

function Spark({ x, y, s = 5, o = 0.5 }: { x: number; y: number; s?: number; o?: number }) {
  return (
    <path
      d={`M${x} ${y - s}Q${x} ${y} ${x + s} ${y}Q${x} ${y} ${x} ${y + s}Q${x} ${y} ${x - s} ${y}Q${x} ${y} ${x} ${y - s}Z`}
      fill="currentColor"
      fillOpacity={o}
    />
  )
}

function Rows({ x, y, widths, gap = 10, o = 0.18 }: { x: number; y: number; widths: number[]; gap?: number; o?: number }) {
  return (
    <>
      {widths.map((w, index) => (
        <Bar key={index} x={x} y={y + index * gap} w={w} o={o} />
      ))}
    </>
  )
}

export function RunsArt() {
  return (
    <Art>
      <Panel x={72} y={14} w={124} h={80} tone="faint" />
      <Panel x={44} y={30} w={150} h={102} r={9} />
      <Dot cx={56} cy={42} r={2.25} />
      <Dot cx={64} cy={42} r={2.25} />
      <Dot cx={72} cy={42} r={2.25} />
      <path d="M44 53H194" {...lineProps('faint')} />
      <path d="M56 63l4 3.5-4 3.5" {...lineProps('mid', 1.5)} />
      <Bar x={68} y={64.5} w={72} o={0.34} />
      <Bar x={68} y={76} w={94} o={0.15} />
      <rect x={68} y={87} width={58} height={13} rx={3.5} {...lineProps('soft')} />
      <Dot cx={76} cy={93.5} />
      <Bar x={82} y={91.5} w={36} o={0.2} />
      <Bar x={68} y={108} w={46} o={0.15} />
      <Badge cx={180} cy={112} r={22}>
        <path
          d="M173 101.5v21L191 112Z"
          fill="currentColor"
          fillOpacity={0.78}
          stroke="currentColor"
          strokeOpacity={0.78}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </Badge>
      <Spark x={216} y={38} s={6} />
      <Spark x={28} y={100} s={4} o={0.3} />
    </Art>
  )
}

export function InboxArt() {
  return (
    <Art>
      <Solid d="M56 86 73 58H167L184 86V120a6 6 0 0 1-6 6H62a6 6 0 0 1-6-6Z" />
      <path d="M56 86H92l8 13h40l8-13H184" {...lineProps()} />
      <Bar x={102} y={110} w={36} o={0.14} />
      <Badge cx={120} cy={50} r={23}>
        <path d="M109.5 50.5l7.5 7.5 14-15" {...lineProps('strong', 2.25)} />
      </Badge>
      <Spark x={72} y={32} s={6} />
      <Spark x={170} y={26} s={4} o={0.35} />
      <Spark x={198} y={58} s={5} o={0.3} />
    </Art>
  )
}

export function IssuesArt() {
  return (
    <Art>
      <Panel x={52} y={16} w={136} h={32} tone="faint" />
      <circle cx={69} cy={32} r={6} {...lineProps('soft')} strokeDasharray="2.5 3" />
      <Bar x={84} y={30} w={60} o={0.13} />
      <Dot cx={171} cy={32} r={5.5} o={0.1} />

      <Panel x={36} y={54} w={168} h={42} r={9} tone="strong" />
      <circle cx={57} cy={75} r={8} {...lineProps('strong', 1.5)} />
      <path d="M57 70.5a4.5 4.5 0 0 1 0 9Z" fill="currentColor" fillOpacity={0.72} />
      <Bar x={75} y={66} w={82} o={0.36} />
      <Bar x={75} y={78} w={48} o={0.15} />
      <Dot cx={184} cy={75} r={8} o={0.22} />

      <Panel x={52} y={102} w={136} h={32} tone="faint" />
      <circle cx={69} cy={118} r={6} fill="currentColor" fillOpacity={0.24} />
      <path d="M66 118l2.2 2.2 3.8-4.2" {...lineProps('strong', 1.25)} />
      <Bar x={84} y={116} w={52} o={0.13} />
      <Dot cx={171} cy={118} r={5.5} o={0.1} />
    </Art>
  )
}

export function NoMatchArt() {
  return (
    <Art>
      {[26, 60, 94].map((y) => (
        <g key={y}>
          <Panel x={30} y={y} w={140} h={26} r={6} tone="faint" dashed />
          <Dot cx={44} cy={y + 13} r={3} o={0.14} />
          <Bar x={54} y={y + 11} w={58} o={0.09} />
        </g>
      ))}
      <path d="M165 94 192 122" {...lineProps('strong', 5)} />
      <Badge cx={142} cy={70} r={33}>
        <path d="M131 59l22 22M153 59l-22 22" {...lineProps('mid', 2)} />
      </Badge>
    </Art>
  )
}

export function AgentsArt() {
  return (
    <Art>
      <circle cx={42} cy={82} r={19} {...lineProps('soft')} strokeDasharray="3 4" />
      <path d="M42 76v12M36 82h12" {...lineProps('soft')} />
      <circle cx={198} cy={82} r={19} {...lineProps('soft')} strokeDasharray="3 4" />
      <path d="M198 76v12M192 82h12" {...lineProps('soft')} />
      <path d="M61 82H76M164 82H179" {...lineProps('faint')} strokeDasharray="2 4" />

      <path d="M120 38V26" {...lineProps('strong', 1.5)} />
      <circle cx={120} cy={21} r={4.5} fill="currentColor" fillOpacity={0.6} />
      <rect x={76} y={60} width={10} height={20} rx={3} {...lineProps('mid')} />
      <rect x={154} y={60} width={10} height={20} rx={3} {...lineProps('mid')} />
      <Panel x={84} y={38} w={72} h={62} r={17} tone="strong" />
      <rect x={101} y={58} width={10} height={16} rx={5} fill="currentColor" fillOpacity={0.78} />
      <rect x={129} y={58} width={10} height={16} rx={5} fill="currentColor" fillOpacity={0.78} />
      <path d="M109 85q11 6 22 0" {...lineProps('mid', 1.5)} />
      <path d="M112 100V112M128 100V112" {...lineProps('soft')} />
      <Solid d="M92 134a28 26 0 0 1 56 0Z" tone="soft" />
      <Dot cx={120} cy={121} r={3} o={0.3} />
      <Spark x={176} y={32} s={6} />
      <Spark x={62} y={40} s={4} o={0.35} />
    </Art>
  )
}

export function SkillsArt() {
  return (
    <Art>
      <g transform="rotate(-13 120 134)">
        <Panel x={84} y={26} w={72} h={100} tone="faint" />
      </g>
      <g transform="rotate(13 120 134)">
        <Panel x={84} y={26} w={72} h={100} tone="faint" />
      </g>
      <Panel x={80} y={20} w={80} h={112} r={9} tone="strong" />
      <Spark x={120} y={56} s={20} o={0.72} />
      <Spark x={143} y={36} s={6} o={0.4} />
      <Spark x={98} y={74} s={4} o={0.3} />
      <Bar x={94} y={92} w={52} o={0.3} />
      <Bar x={94} y={103} w={38} o={0.15} />
      <Bar x={94} y={114} w={46} o={0.15} />
    </Art>
  )
}

export function ArchetypesArt() {
  const cross = (x: number, y: number) => `M${x - 4} ${y}H${x + 4}M${x} ${y - 4}V${y + 4}`
  return (
    <Art>
      <path d={[cross(30, 22), cross(210, 22), cross(30, 128), cross(210, 128)].join('')} {...lineProps('soft')} />
      <path d="M30 42H210M30 112H210M60 22V128M180 22V128" {...lineProps('faint')} strokeDasharray="2 5" />
      <circle cx={92} cy={82} r={30} {...lineProps('mid', 1.5)} fill="currentColor" fillOpacity={0.07} />
      <rect x={118} y={52} width={60} height={60} rx={10} {...lineProps('mid', 1.5)} fill="currentColor" fillOpacity={0.07} />
      <path d="M121 20 156 80H86Z" {...lineProps('strong', 1.5)} fill="currentColor" fillOpacity={0.13} />
    </Art>
  )
}

function FlowNode({ x, y, tone, dashed, glyph, w = 54 }: { x: number; y: number; tone: Tone; dashed?: boolean; glyph: ReactNode; w?: number }) {
  return (
    <>
      <Panel x={x} y={y} w={w} h={36} r={7} tone={tone} dashed={dashed} />
      <g transform={`translate(${x + 8} ${y + 11})`}>{glyph}</g>
      <Bar x={x + 26} y={y + 12} w={w - 34} o={0.3} />
      <Bar x={x + 26} y={y + 21} w={w - 42} o={0.13} />
    </>
  )
}

export function WorkflowsArt() {
  const square = (o: number) => <rect width={14} height={14} rx={4} fill="currentColor" fillOpacity={o} />
  return (
    <Art>
      <path d="M68 75H93" {...lineProps()} />
      <path d="M147 75C160 75 158 37 172 37" {...lineProps()} />
      <path d="M147 75C160 75 158 113 172 113" {...lineProps('soft')} strokeDasharray="3 4" />
      <FlowNode x={14} y={57} tone="mid" glyph={square(0.26)} />
      <FlowNode x={93} y={57} tone="strong" glyph={square(0.62)} />
      <FlowNode x={172} y={19} tone="mid" glyph={square(0.26)} />
      <FlowNode x={172} y={95} tone="soft" dashed glyph={square(0.12)} />
      {[
        [68, 75],
        [93, 75],
        [147, 75],
        [172, 37],
        [172, 113],
      ].map(([cx, cy]) => (
        <g key={`${cx}-${cy}`}>
          <circle cx={cx} cy={cy} r={2.75} fill="var(--canvas)" />
          <circle cx={cx} cy={cy} r={2.75} {...lineProps('strong')} />
        </g>
      ))}
    </Art>
  )
}

export function HistoryArt() {
  return (
    <Art>
      <path d="M74 75H96M96 34V116" {...lineProps('soft')} />
      {[20, 61].map((y, index) => (
        <g key={y}>
          <circle cx={96} cy={y + 14} r={5} fill="var(--canvas)" />
          <circle cx={96} cy={y + 14} r={5} fill="currentColor" fillOpacity={index === 0 ? 0.3 : 0.62} />
          <Panel x={112} y={y} w={102} h={28} r={7} tone={index === 0 ? 'faint' : 'mid'} />
          <Bar x={123} y={y + 8} w={index === 0 ? 50 : 62} o={index === 0 ? 0.14 : 0.32} />
          <Bar x={123} y={y + 17} w={32} o={0.12} />
        </g>
      ))}
      <circle cx={96} cy={116} r={5} fill="var(--canvas)" />
      <circle cx={96} cy={116} r={5} {...lineProps('soft')} strokeDasharray="2 2.5" />
      <Panel x={112} y={102} w={102} h={28} r={7} tone="faint" dashed />
      <Badge cx={48} cy={75} r={26}>
        <path d="M48 60V75L58 82" {...lineProps('strong', 2)} />
      </Badge>
    </Art>
  )
}

export function ConnectionsArt() {
  return (
    <Art>
      <path d="M80 75H98M160 75H142" {...lineProps('mid', 1.5)} />
      <Panel x={24} y={47} w={56} h={56} r={13} />
      <rect x={38} y={61} width={7} height={28} rx={2.5} fill="currentColor" fillOpacity={0.3} />
      <rect x={48.5} y={61} width={7} height={18} rx={2.5} fill="currentColor" fillOpacity={0.3} />
      <rect x={59} y={61} width={7} height={23} rx={2.5} fill="currentColor" fillOpacity={0.3} />
      <Panel x={160} y={47} w={56} h={56} r={13} />
      <path d="M179 83V67M179 75C192 75 197 73 197 67" {...lineProps('mid', 1.75)} />
      <circle cx={179} cy={85} r={3.5} fill="currentColor" fillOpacity={0.42} />
      <circle cx={179} cy={65} r={3.5} fill="currentColor" fillOpacity={0.42} />
      <circle cx={197} cy={65} r={3.5} fill="currentColor" fillOpacity={0.42} />
      <path d="M112 68H121M112 82H121" {...lineProps('strong', 2.25)} />
      <Panel x={98} y={61} w={14} h={28} r={4.5} tone="strong" />
      <Panel x={128} y={61} w={14} h={28} r={4.5} tone="strong" />
      <Dot cx={132.5} cy={68} r={1.5} o={0.6} />
      <Dot cx={132.5} cy={82} r={1.5} o={0.6} />
      <Spark x={124} y={46} s={5} />
      <Spark x={116} y={106} s={3.5} o={0.32} />
    </Art>
  )
}

export function AuditArt() {
  return (
    <Art>
      <g transform="rotate(5 120 75)">
        <Panel x={70} y={14} w={108} h={118} tone="faint" />
      </g>
      <Panel x={60} y={18} w={114} h={118} tone="mid" />
      {[
        [34, 56],
        [50, 44],
        [66, 62],
        [82, 36],
        [98, 50],
        [114, 30],
      ].map(([y, w]) => (
        <g key={y}>
          <Dot cx={74} cy={Number(y) + 2} r={3} o={0.28} />
          <Bar x={84} y={Number(y)} w={Number(w)} o={0.2} />
          <Bar x={150} y={Number(y)} w={12} o={0.1} />
        </g>
      ))}
      <Badge cx={172} cy={112} r={21}>
        <path d="M163 112.5l6.5 6.5 12-13" {...lineProps('strong', 2.25)} />
      </Badge>
    </Art>
  )
}

export function NoChangesArt() {
  const widths = [44, 30, 52, 22, 40, 32]
  return (
    <Art>
      <Panel x={24} y={26} w={82} h={98} />
      <path d="M24 42H106" {...lineProps('faint')} />
      <Dot cx={34} cy={34} />
      <Rows x={34} y={51} widths={widths} gap={11} />
      <Panel x={134} y={26} w={82} h={98} />
      <path d="M134 42H216" {...lineProps('faint')} />
      <Dot cx={144} cy={34} />
      <Rows x={144} y={51} widths={widths} gap={11} />
      <Badge cx={120} cy={75} r={17}>
        <path d="M112.5 71H127.5M112.5 79H127.5" {...lineProps('strong', 2.25)} />
      </Badge>
    </Art>
  )
}

export function ProjectsArt() {
  return (
    <Art>
      <Solid d="M50 40a6 6 0 0 1 6-6H94l11 13H184a6 6 0 0 1 6 6V122H50Z" tone="soft" />
      <g transform="rotate(-5 110 70)">
        <Panel x={72} y={26} w={82} h={62} r={7} tone="mid" />
        <Bar x={84} y={38} w={44} o={0.3} />
        <Bar x={84} y={48} w={30} o={0.14} />
      </g>
      <g transform="rotate(6 140 70)">
        <Panel x={98} y={36} w={78} h={56} r={7} tone="mid" />
        <Bar x={110} y={48} w={40} o={0.3} />
        <Bar x={110} y={58} w={50} o={0.14} />
      </g>
      <Solid d="M42 76a6 6 0 0 1 6-6H192a6 6 0 0 1 6 6L192 122a6 6 0 0 1-6 6H54a6 6 0 0 1-6-6Z" tone="strong" />
      <Bar x={100} y={96} w={40} o={0.2} />
      <Spark x={208} y={40} s={6} />
      <Spark x={30} y={54} s={4} o={0.32} />
    </Art>
  )
}

export function ProblemArt() {
  return (
    <Art>
      <Solid d="M52 24a8 8 0 0 1 8-8H180a8 8 0 0 1 8 8V58L170 70 150 56 130 70 110 56 90 70 70 56 52 68Z" />
      <Dot cx={65} cy={29} r={2.25} />
      <Dot cx={73} cy={29} r={2.25} />
      <Dot cx={81} cy={29} r={2.25} />
      <Bar x={65} y={42} w={78} o={0.2} />
      <g transform="translate(5 14)">
        <Solid d="M52 80 70 68 90 82 110 68 130 82 150 68 170 82 188 70V112a8 8 0 0 1-8 8H60a8 8 0 0 1-8-8Z" />
        <Bar x={65} y={94} w={92} o={0.15} />
        <Bar x={65} y={105} w={56} o={0.15} />
      </g>
      <Badge cx={196} cy={28} r={15}>
        <path d="M196 20.5v9" {...lineProps('strong', 2.25)} />
        <Dot cx={196} cy={35} r={1.5} o={0.72} />
      </Badge>
      <Spark x={36} y={72} s={5} o={0.4} />
      <Spark x={214} y={80} s={3.5} o={0.3} />
    </Art>
  )
}

export function NotFoundArt() {
  const ticks = Array.from({ length: 12 }, (_, index) => index * 30)
  return (
    <Art>
      <Panel x={54} y={14} w={132} h={122} r={9} tone="soft" dashed />
      <Bar x={68} y={28} w={38} o={0.1} />
      <Bar x={68} y={120} w={52} o={0.1} />
      <Badge cx={120} cy={75} r={36}>
        {ticks.map((angle) => (
          <path key={angle} d="M120 44v4" transform={`rotate(${angle} 120 75)`} {...lineProps(angle % 90 === 0 ? 'strong' : 'soft')} />
        ))}
        <g transform="rotate(38 120 75)">
          <path d="M120 51 127 75H113Z" fill="currentColor" fillOpacity={0.78} />
          <path d="M120 99 127 75H113Z" fill="currentColor" fillOpacity={0.2} />
        </g>
        <circle cx={120} cy={75} r={2.25} fill="var(--canvas)" />
      </Badge>
      <Spark x={204} y={36} s={6} />
      <Spark x={36} y={110} s={4} o={0.32} />
    </Art>
  )
}
