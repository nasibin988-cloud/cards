'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Exam, ExamQuestion } from '@/lib/db/schema';
import { getExam, getExamQuestions, deleteExam } from '@/lib/exam/queries';
import { renderRichText } from '@/lib/cloze/parser';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';

export default function ExamResult({ examId }: { examId: string }) {
  const router = useRouter();
  const [exam, setExam] = useState<Exam | null | undefined>(undefined);
  const [questions, setQuestions] = useState<ExamQuestion[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    (async () => {
      const e = await getExam(examId);
      setExam(e ?? null);
      if (!e) return;
      setQuestions(await getExamQuestions(examId));
    })();
  }, [examId]);

  if (exam === undefined) {
    return <div className="max-w-2xl mx-auto px-6 py-10 text-dark-400">Loading…</div>;
  }
  if (!exam) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-dark-300">Exam not found.</p>
        <Link href="/" className="text-saffron-300 underline">← Decks</Link>
      </div>
    );
  }

  const overall = exam.scoreOverall ?? 0;
  const correct = questions.filter(q => (q.score ?? 0) >= 0.999).length;
  const partial = questions.filter(q => (q.score ?? 0) > 0 && (q.score ?? 0) < 0.999).length;
  const wrong = questions.filter(q => (q.score ?? 0) === 0).length;

  const elapsedMs = exam.startedAt && exam.submittedAt ? exam.submittedAt - exam.startedAt : 0;
  const minutes = Math.floor(elapsedMs / 60_000);
  const seconds = Math.floor((elapsedMs % 60_000) / 1000);

  const remove = async () => {
    await deleteExam(examId);
    router.push(`/deck/${exam.deckId}`);
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <Link href={`/deck/${exam.deckId}`} className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition">
        ← {exam.title}
      </Link>
      <div className="mt-4 mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <h1 className="text-5xl md:text-6xl font-extralight tracking-tight tabular-nums">
            {Math.round(overall * 100)}%
          </h1>
          <p className="text-dark-400 font-light text-sm mt-2">
            {correct} correct · {partial} partial · {wrong} wrong
            {elapsedMs > 0 && <> · {minutes}m {seconds}s</>}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/exam/new/${exam.deckId}`}
            className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light"
          >
            New exam
          </Link>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="px-4 py-2 rounded-xl text-sm text-dark-400 hover:text-crimson-300 transition"
            >
              Delete
            </button>
          ) : (
            <>
              <button onClick={remove} className="px-4 py-2 rounded-xl text-sm bg-crimson-900/40 text-crimson-200 hover:bg-crimson-800/50 transition">
                Confirm
              </button>
              <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 rounded-xl text-sm text-dark-300 hover:text-dark-100 transition">
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {questions.map((q, i) => (
          <QuestionRow key={q.id} q={q} index={i} />
        ))}
      </div>
    </div>
  );
}

function QuestionRow({ q, index }: { q: ExamQuestion; index: number }) {
  const [open, setOpen] = useState(false);
  const score = q.score ?? 0;
  const tone = score >= 0.999 ? 'right'
    : score > 0 ? 'partial'
    : 'wrong';

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 flex items-center gap-4 hover:bg-white/[0.02] transition text-left"
      >
        <span className="text-2xs uppercase tracking-widest font-mono text-dark-500 shrink-0 w-8">
          {(index + 1).toString().padStart(2, '0')}
        </span>
        <ScoreBadge tone={tone} score={score} />
        <span className="flex-1 text-sm font-light text-dark-100 truncate">
          {stripMd(q.prompt)}
        </span>
        <span className="text-2xs uppercase tracking-[0.2em] font-light text-dark-500 shrink-0">
          {q.type}
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-white/[0.04] space-y-4">
          <div
            className="card-prose text-sm font-light leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderRichText(q.prompt) }}
          />
          {q.type === 'mcq' && q.choices && (
            <div className="space-y-1.5">
              {q.choices.map((c, i) => {
                const isCorrect = i === q.correctIndex;
                const isUser = i === q.userChoiceIndex;
                return (
                  <div
                    key={i}
                    className={cn(
                      'rounded-xl px-3 py-2 text-sm font-light border',
                      isCorrect
                        ? 'border-saffron-700/40 bg-saffron-900/20 text-saffron-100'
                        : isUser
                        ? 'border-crimson-700/40 bg-crimson-900/20 text-crimson-100'
                        : 'border-white/[0.04] bg-dark-800/20 text-dark-300',
                    )}
                  >
                    <span className="text-2xs uppercase tracking-widest font-mono mr-2 opacity-60">
                      {String.fromCharCode(65 + i)}
                    </span>
                    {c}
                    {isCorrect && <span className="ml-2 text-2xs uppercase tracking-widest opacity-70">correct</span>}
                    {isUser && !isCorrect && <span className="ml-2 text-2xs uppercase tracking-widest opacity-70">your pick</span>}
                  </div>
                );
              })}
            </div>
          )}
          {q.type === 'free' && (
            <div className="space-y-3">
              <Field label="Your answer" body={q.userAnswer || '(empty)'} tone={tone} />
              {q.expectedAnswer && (
                <Field label="Model answer" body={q.expectedAnswer} tone="model" />
              )}
              {q.feedback && (
                <Field label="Feedback" body={q.feedback} tone="feedback" markdown />
              )}
            </div>
          )}
          {q.sourceNoteIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-2 border-t border-white/[0.04]">
              <span className="text-2xs uppercase tracking-widest text-dark-500 mr-1">Source:</span>
              {q.sourceNoteIds.map(id => (
                <Link
                  key={id}
                  href={`/note/${id}`}
                  className="text-2xs uppercase tracking-widest font-mono text-dark-400 hover:text-saffron-300 transition px-2 py-0.5 rounded bg-dark-800/40 border border-white/[0.04]"
                >
                  {id.slice(-6)}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label, body, tone, markdown,
}: { label: string; body: string; tone: 'right' | 'partial' | 'wrong' | 'model' | 'feedback'; markdown?: boolean }) {
  const labelTone = {
    right: 'text-saffron-300',
    partial: 'text-saffron-400',
    wrong: 'text-crimson-300',
    model: 'text-persian-300',
    feedback: 'text-dark-300',
  }[tone];
  return (
    <div>
      <div className={cn('text-2xs uppercase tracking-widest mb-1.5', labelTone)}>{label}</div>
      {markdown
        ? <div className="card-prose text-sm font-light leading-relaxed text-dark-100" dangerouslySetInnerHTML={{ __html: renderRichText(body) }} />
        : <div className="text-sm font-light leading-relaxed text-dark-100 whitespace-pre-wrap">{body}</div>}
    </div>
  );
}

function ScoreBadge({ tone, score }: { tone: 'right' | 'partial' | 'wrong'; score: number }) {
  const cls = tone === 'right' ? 'bg-saffron-900/40 text-saffron-200 border-saffron-700/30'
    : tone === 'partial' ? 'bg-saffron-900/20 text-saffron-300 border-saffron-700/20'
    : 'bg-crimson-900/30 text-crimson-200 border-crimson-700/30';
  const label = tone === 'right' ? '✓' : tone === 'partial' ? `${Math.round(score * 100)}%` : '✗';
  return (
    <span className={cn('shrink-0 w-12 text-center text-xs uppercase tracking-widest font-mono px-2 py-1 rounded-md border', cls)}>
      {label}
    </span>
  );
}

function stripMd(s: string): string {
  return s.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
}
