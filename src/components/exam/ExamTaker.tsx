'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Exam, ExamQuestion, Note } from '@/lib/db/schema';
import {
  getExam,
  getExamQuestions,
  updateExam,
  updateExamQuestion,
} from '@/lib/exam/queries';
import { getNote } from '@/lib/db/queries';
import { gradeFreeResponse } from '@/lib/exam/generator';
import { renderRichText } from '@/lib/cloze/parser';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

export default function ExamTaker({ examId }: { examId: string }) {
  const router = useRouter();
  const [exam, setExam] = useState<Exam | null | undefined>(undefined);
  const [questions, setQuestions] = useState<ExamQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [choiceIndex, setChoiceIndex] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const e = await getExam(examId);
      setExam(e ?? null);
      if (!e) return;
      const qs = await getExamQuestions(examId);
      setQuestions(qs);
      // Resume at first unanswered question if there is one.
      const firstUnanswered = qs.findIndex(q => q.score === undefined && !q.userAnswer && q.userChoiceIndex === undefined);
      const startIndex = firstUnanswered === -1 ? 0 : firstUnanswered;
      setIndex(startIndex);
      hydrateAnswer(qs[startIndex]);
      if (e.status === 'draft') {
        await updateExam(examId, { status: 'in_progress', startedAt: Date.now() });
      }
    })();
  }, [examId]);

  function hydrateAnswer(q: ExamQuestion | undefined) {
    if (!q) { setAnswer(''); setChoiceIndex(null); return; }
    setAnswer(q.userAnswer ?? '');
    setChoiceIndex(typeof q.userChoiceIndex === 'number' ? q.userChoiceIndex : null);
  }

  const cur = questions[index];

  const persistCurrent = async () => {
    if (!cur) return;
    if (cur.type === 'mcq') {
      const ci = choiceIndex;
      if (ci === null) return;
      await updateExamQuestion(cur.id, {
        userChoiceIndex: ci,
        score: ci === cur.correctIndex ? 1 : 0,
      });
      setQuestions(prev => prev.map(q => q.id === cur.id
        ? { ...q, userChoiceIndex: ci, score: ci === cur.correctIndex ? 1 : 0 }
        : q));
    } else {
      await updateExamQuestion(cur.id, { userAnswer: answer });
      setQuestions(prev => prev.map(q => q.id === cur.id ? { ...q, userAnswer: answer } : q));
    }
  };

  const goNext = async () => {
    await persistCurrent();
    if (index + 1 < questions.length) {
      setIndex(index + 1);
      hydrateAnswer(questions[index + 1]);
    }
  };

  const goPrev = () => {
    if (index === 0) return;
    setIndex(index - 1);
    hydrateAnswer(questions[index - 1]);
  };

  const submit = async () => {
    await persistCurrent();
    setSubmitting(true);
    try {
      // Reload questions with persisted answers so the grader sees them.
      const qs = await getExamQuestions(examId);
      // Grade free responses; MCQ already auto-scored.
      const sourceNoteIds = new Set<string>();
      for (const q of qs) for (const id of q.sourceNoteIds) sourceNoteIds.add(id);
      const notes: Note[] = [];
      for (const id of sourceNoteIds) {
        const n = await getNote(id);
        if (n) notes.push(n);
      }
      let totalScore = 0;
      for (const q of qs) {
        if (q.type === 'mcq') {
          totalScore += q.score ?? 0;
        } else {
          if (q.userAnswer && q.score === undefined) {
            try {
              const { score, feedback } = await gradeFreeResponse(q, notes);
              await updateExamQuestion(q.id, { score, feedback });
              totalScore += score;
            } catch {
              await updateExamQuestion(q.id, { score: 0, feedback: '[grader error]' });
            }
          } else {
            totalScore += q.score ?? 0;
          }
        }
      }
      const overall = totalScore / Math.max(1, qs.length);
      await updateExam(examId, {
        status: 'submitted',
        submittedAt: Date.now(),
        scoreOverall: overall,
      });
      router.push(`/exam/result/${examId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Submit failed: ${msg}`);
      setSubmitting(false);
    }
  };

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
  if (exam.status === 'submitted') {
    router.push(`/exam/result/${examId}`);
    return null;
  }
  if (!cur) return null;

  const answered = cur.type === 'mcq' ? choiceIndex !== null : answer.trim().length > 0;
  const lastQ = index === questions.length - 1;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/[0.04] backdrop-blur-md bg-dark-950/40 sticky top-0 z-30 gap-4">
        <Tooltip content={exam.title} side="bottom">
          <Link href={`/deck/${exam.deckId}`} className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition shrink-0 truncate max-w-[40%]">
            ← {exam.title}
          </Link>
        </Tooltip>
        <div className="flex-1 flex items-center gap-3 max-w-md">
          <div className="flex-1 h-1.5 rounded-full bg-dark-800/60 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-saffron-500 to-persian-400 transition-all duration-300"
              style={{ width: `${((index + 1) / questions.length) * 100}%` }}
            />
          </div>
          <span className="text-2xs uppercase tracking-widest tabular-nums text-dark-400 shrink-0">
            {index + 1}/{questions.length}
          </span>
        </div>
        <div className="text-2xs uppercase tracking-[0.2em] font-light text-dark-500 shrink-0">
          {cur.type === 'mcq' ? 'MCQ' : 'Free'}
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center pt-10 pb-10 px-6 max-w-3xl mx-auto w-full">
        <div className="w-full glass-card rounded-3xl p-7 md:p-9 space-y-6">
          <div
            className="card-prose text-lg md:text-xl font-light leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderRichText(cur.prompt) }}
          />

          {cur.type === 'mcq' && cur.choices && (
            <div className="space-y-2">
              {cur.choices.map((c, i) => {
                const selected = choiceIndex === i;
                return (
                  <button
                    key={i}
                    onClick={() => setChoiceIndex(i)}
                    className={cn(
                      'w-full text-left rounded-xl px-4 py-3 transition border',
                      selected
                        ? 'bg-persian-900/30 border-saffron-700/40 text-dark-50'
                        : 'bg-dark-800/30 border-white/[0.04] text-dark-200 hover:bg-white/[0.04] hover:text-dark-100',
                    )}
                  >
                    <span className="text-2xs uppercase tracking-widest font-mono text-dark-500 mr-3">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className="font-light">{c}</span>
                  </button>
                );
              })}
            </div>
          )}

          {cur.type === 'free' && (
            <textarea
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              placeholder="Type your answer…"
              rows={5}
              className="w-full bg-dark-800/30 rounded-xl px-4 py-3 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04]"
            />
          )}
        </div>

        <div className="w-full flex items-center justify-between mt-6">
          <button
            onClick={goPrev}
            disabled={index === 0}
            className="px-4 py-2 rounded-xl text-sm text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Previous
          </button>
          {lastQ ? (
            <button
              onClick={submit}
              disabled={submitting}
              className="btn-gradient px-6 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
            >
              {submitting ? 'Grading…' : 'Submit exam'}
            </button>
          ) : (
            <button
              onClick={goNext}
              disabled={!answered}
              className="btn-gradient px-6 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
            >
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
