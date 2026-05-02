import { db } from '@/lib/db/dexie';
import type {
  Card,
  Exam,
  ExamConfig,
  ExamCoverage,
  ExamQuestion,
  Note,
} from '@/lib/db/schema';
import { id } from '@/lib/ulid';

const now = () => Date.now();

export async function listExamsForDeck(deckId: string): Promise<Exam[]> {
  return db().exams.where('deckId').equals(deckId).reverse().sortBy('createdAt');
}

export async function listAllExams(limit = 100): Promise<Exam[]> {
  return db().exams.orderBy('createdAt').reverse().limit(limit).toArray();
}

export async function getExam(examId: string): Promise<Exam | undefined> {
  return db().exams.get(examId);
}

export async function getExamQuestions(examId: string): Promise<ExamQuestion[]> {
  return db().examQuestions.where('examId').equals(examId).sortBy('index');
}

export async function createExam(input: {
  deckId: string;
  title: string;
  config: ExamConfig;
  questions: Array<Omit<ExamQuestion, 'id' | 'examId'>>;
}): Promise<Exam> {
  const exam: Exam = {
    id: id(),
    deckId: input.deckId,
    title: input.title,
    config: input.config,
    status: 'draft',
    createdAt: now(),
  };
  const dbi = db();
  await dbi.transaction('rw', dbi.exams, dbi.examQuestions, async () => {
    await dbi.exams.put(exam);
    const qs: ExamQuestion[] = input.questions.map(q => ({ ...q, id: id(), examId: exam.id }));
    await dbi.examQuestions.bulkPut(qs);
  });
  return exam;
}

export async function updateExam(examId: string, patch: Partial<Exam>): Promise<void> {
  await db().exams.update(examId, patch);
}

export async function updateExamQuestion(qid: string, patch: Partial<ExamQuestion>): Promise<void> {
  await db().examQuestions.update(qid, patch);
}

export async function deleteExam(examId: string): Promise<void> {
  const dbi = db();
  await dbi.transaction('rw', dbi.exams, dbi.examQuestions, async () => {
    await dbi.examQuestions.where('examId').equals(examId).delete();
    await dbi.exams.delete(examId);
  });
}

/**
 * Pick the cards that source-feed an exam given a deck and a coverage strategy.
 * Returns at most `cap` notes, biased toward the chosen strategy.
 */
export async function pickSourceNotes(
  deckId: string,
  coverage: ExamCoverage,
  cap: number,
): Promise<Note[]> {
  const dbi = db();
  const notes = await dbi.notes.where('deckId').equals(deckId).toArray();
  if (notes.length === 0) return [];

  if (coverage.kind === 'tags' && coverage.tags.length > 0) {
    const tagSet = new Set(coverage.tags);
    const filtered = notes.filter(n => n.tags.some(t => tagSet.has(t)));
    return shuffle(filtered).slice(0, cap);
  }

  if (coverage.kind === 'lapses') {
    const cards = await dbi.cards.where('deckId').equals(deckId).toArray();
    const lapsesByNote = new Map<string, number>();
    for (const c of cards) {
      lapsesByNote.set(c.noteId, (lapsesByNote.get(c.noteId) ?? 0) + c.lapses);
    }
    const ranked = notes
      .map(n => ({ n, lapses: lapsesByNote.get(n.id) ?? 0 }))
      .filter(x => x.lapses > 0)
      .sort((a, b) => b.lapses - a.lapses);
    if (ranked.length >= cap) {
      // Top 80% by lapses, then a 20% random sprinkle for breadth
      const top = Math.floor(cap * 0.8);
      const breadth = cap - top;
      const rest = shuffle(notes.filter(n => !ranked.slice(0, top).map(r => r.n.id).includes(n.id)));
      return [
        ...ranked.slice(0, top).map(r => r.n),
        ...rest.slice(0, breadth),
      ];
    }
    // Not enough lapsed cards — fall through to random.
  }

  // Default: random.
  return shuffle(notes).slice(0, cap);
}

export async function getCardsForNotes(noteIds: string[]): Promise<Card[]> {
  if (noteIds.length === 0) return [];
  return db().cards.where('noteId').anyOf(noteIds).toArray();
}

function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
