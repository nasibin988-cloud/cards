'use client';

import { useState } from 'react';
import type { LayeredExplanations } from '@/lib/ai/explain';
import { cn } from '@/lib/utils';

/**
 * Three-tab layered-explanation panel that slides down below the card
 * when the user presses X. Simple / Deep / Analogy in saffron pill
 * tabs at the top, body fades across when you switch. Mounted only
 * when `open` is true; unmount completes the slide-up exit via the
 * caller's animation choice.
 */

type Layer = 'simple' | 'deep' | 'analogy';

interface Props {
  explanations: LayeredExplanations;
  onClose: () => void;
  onRegenerate: () => void;
  busy?: boolean;
}

const LAYER_LABEL: Record<Layer, string> = {
  simple:  'Simple',
  deep:    'Deep',
  analogy: 'Analogy',
};

const LAYER_HINT: Record<Layer, string> = {
  simple:  'plain-language intuition',
  deep:    'full mechanism + why',
  analogy: 'concrete metaphor',
};

export default function ExplanationPanel({ explanations, onClose, onRegenerate, busy }: Props) {
  const [layer, setLayer] = useState<Layer>('simple');
  const text = explanations[layer];

  return (
    <div className="explanation-panel glass-card rounded-2xl p-5 md:p-6 mt-4 animate-explanation-in">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="inline-flex items-center gap-1.5 p-1 rounded-xl bg-dark-800/40 border border-white/[0.04]">
          {(['simple', 'deep', 'analogy'] as const).map(l => (
            <button
              key={l}
              onClick={() => setLayer(l)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-2xs uppercase tracking-widest font-mono transition',
                layer === l
                  ? 'bg-saffron-900/40 text-saffron-200 shadow-inner'
                  : 'text-dark-400 hover:text-dark-200 hover:bg-white/[0.03]',
              )}
              aria-pressed={layer === l}
            >
              {LAYER_LABEL[l]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-2xs uppercase tracking-widest text-dark-500 font-mono">
          <span className="hidden md:inline">{LAYER_HINT[layer]}</span>
          <button
            onClick={onRegenerate}
            disabled={busy}
            className="text-dark-400 hover:text-saffron-300 transition disabled:opacity-50"
            title="Regenerate with Opus (⇧X)"
          >
            {busy ? 'regenerating…' : 'regenerate'}
          </button>
          <button
            onClick={onClose}
            className="text-dark-400 hover:text-dark-100 transition"
            title="Close (X)"
          >
            close
          </button>
        </div>
      </div>

      {/* key-bump so a layer switch replays the fade-cross animation
          instead of a hard text swap. */}
      <div
        key={`${layer}-${explanations.generatedAt}`}
        className="text-sm md:text-[0.95rem] leading-relaxed font-light text-dark-100 animate-explanation-text"
      >
        {text}
      </div>

      <div className="text-2xs uppercase tracking-widest text-dark-600 font-mono mt-3 pt-3 border-t border-white/[0.04]">
        Opus · {new Date(explanations.generatedAt).toLocaleString()}
      </div>
    </div>
  );
}
