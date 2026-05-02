'use client';

import type { CardMaturity } from '@/lib/db/queries';

const COLORS = {
  newCards: 'rgb(253 230 138)',  // saffron-300
  learning: 'rgb(252 165 165)',  // crimson-300
  young: 'rgb(125 211 252)',     // sky-ish persian-tinted
  mature: 'rgb(134 239 172)',    // green
};

const LABELS = {
  newCards: 'New',
  learning: 'Learning',
  young: 'Young',
  mature: 'Mature',
};

export default function MaturityDonut({ maturity }: { maturity: CardMaturity }) {
  const { newCards, learning, young, mature, total } = maturity;
  if (total === 0) {
    return (
      <div className="text-2xs uppercase tracking-widest text-dark-500">
        No cards yet.
      </div>
    );
  }

  // SVG donut: stroke-dasharray trick on a circle.
  const r = 42;
  const c = 2 * Math.PI * r;
  const segments: Array<{ key: keyof typeof COLORS; n: number }> = [
    { key: 'newCards', n: newCards },
    { key: 'learning', n: learning },
    { key: 'young', n: young },
    { key: 'mature', n: mature },
  ];

  let offset = 0;
  const arcs = segments.map(s => {
    const len = (s.n / total) * c;
    const arc = {
      key: s.key,
      color: COLORS[s.key],
      dasharray: `${len} ${c - len}`,
      dashoffset: -offset,
    };
    offset += len;
    return arc;
  });

  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 100 100" width="120" height="120" className="shrink-0 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="transparent" stroke="rgba(255,255,255,0.04)" strokeWidth="10" />
        {arcs.map(a => (
          <circle
            key={a.key}
            cx="50"
            cy="50"
            r={r}
            fill="transparent"
            stroke={a.color}
            strokeWidth="10"
            strokeDasharray={a.dasharray}
            strokeDashoffset={a.dashoffset}
          />
        ))}
        <g transform="rotate(90 50 50)">
          <text
            x="50"
            y="48"
            textAnchor="middle"
            className="fill-dark-100"
            fontSize="14"
            fontWeight="200"
          >
            {total.toLocaleString()}
          </text>
          <text
            x="50"
            y="62"
            textAnchor="middle"
            className="fill-dark-500"
            fontSize="6"
            fontWeight="500"
            letterSpacing="0.18em"
          >
            CARDS
          </text>
        </g>
      </svg>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-2xs">
        {segments.map(s => {
          const pct = total > 0 ? (s.n / total) * 100 : 0;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: COLORS[s.key] }} />
              <span className="uppercase tracking-widest text-dark-300">{LABELS[s.key]}</span>
              <span className="font-mono tabular-nums text-dark-100 ml-auto">
                {s.n.toLocaleString()}
                <span className="text-dark-500 ml-1">{pct.toFixed(0)}%</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
