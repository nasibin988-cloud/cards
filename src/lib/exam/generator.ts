import type Anthropic from '@anthropic-ai/sdk';
import type {
  ExamConfig,
  ExamDifficulty,
  ExamQuestion,
  ExamQuestionType,
  Note,
} from '@/lib/db/schema';
import { makeAnthropicClient } from '@/lib/ai/client';
import { getSetting } from '@/lib/db/queries';
import { DEFAULT_MODEL } from '@/lib/ai/claude';
import { renderPlain } from '@/lib/cloze/parser';

/**
 * AI exam generator.
 *
 * Strategy:
 *   - Take {N} target questions and a pool of source notes.
 *   - Chunk the source notes into batches of ~25 so each prompt fits.
 *   - Ask Claude for ~ceil(N / batches) questions per batch as strict JSON.
 *   - Each batch's source-card block is `cache_control: ephemeral` so re-runs
 *     of the same batch hit the prompt cache.
 *   - Validate, dedupe, shuffle, trim to N.
 *
 * Output is a list of new ExamQuestion records (without id/examId — the
 * caller assigns those when persisting via createExam).
 */

const BATCH_SIZE = 25;

export interface GeneratorProgress {
  stage: 'preparing' | 'generating' | 'finalizing';
  done: number;
  total: number;
  message?: string;
}

interface GenerateInput {
  notes: Note[];                 // source pool, already chosen by coverage
  config: ExamConfig;
  onProgress?: (p: GeneratorProgress) => void;
  signal?: AbortSignal;
}

export async function generateExamQuestions({
  notes, config, onProgress, signal,
}: GenerateInput): Promise<Array<Omit<ExamQuestion, 'id' | 'examId'>>> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  if (notes.length === 0) throw new Error('No source notes available.');

  const batches: Note[][] = [];
  for (let i = 0; i < notes.length; i += BATCH_SIZE) {
    batches.push(notes.slice(i, i + BATCH_SIZE));
  }
  const perBatch = Math.max(1, Math.ceil(config.count / batches.length));

  onProgress?.({
    stage: 'preparing',
    done: 0,
    total: batches.length,
    message: `${notes.length} source notes, ${batches.length} batch${batches.length === 1 ? '' : 'es'}`,
  });

  const collected: GeneratedQ[] = [];
  for (let i = 0; i < batches.length; i++) {
    if (signal?.aborted) throw new Error('Aborted');
    onProgress?.({
      stage: 'generating',
      done: i,
      total: batches.length,
      message: `Batch ${i + 1} of ${batches.length}`,
    });
    const qs = await generateBatch(client, model, batches[i], perBatch, config, signal);
    collected.push(...qs);
  }

  onProgress?.({ stage: 'finalizing', done: batches.length, total: batches.length });

  // Dedupe by prompt-text-prefix; trim to count; shuffle so MCQ/free interleave.
  const seen = new Set<string>();
  const unique = collected.filter(q => {
    const k = q.prompt.slice(0, 80).toLowerCase().trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const trimmed = shuffle(unique).slice(0, config.count);

  return trimmed.map((q, idx) => ({
    index: idx,
    type: q.type,
    prompt: q.prompt,
    choices: q.choices,
    correctIndex: q.correctIndex,
    expectedAnswer: q.expectedAnswer,
    sourceNoteIds: q.sourceNoteIds,
  }));
}

interface GeneratedQ {
  type: ExamQuestionType;
  prompt: string;
  choices?: string[];
  correctIndex?: number;
  expectedAnswer?: string;
  sourceNoteIds: string[];
}

async function generateBatch(
  client: Anthropic,
  model: string,
  notes: Note[],
  count: number,
  config: ExamConfig,
  signal?: AbortSignal,
): Promise<GeneratedQ[]> {
  const sourceCards = notes.map(formatNoteForPrompt).join('\n\n---\n\n');
  const typeMix = describeMix(config.types);
  const difficultyHint = describeDifficulty(config.difficulty);

  const system = `You are an expert exam author for spaced-repetition users studying for high-stakes exams (MCAT, USMLE, board exams).
Given the following source flashcards, write ${count} exam questions in strict JSON format.

Source flashcards:

${sourceCards}

Rules:
1. Every question MUST be answerable strictly from the source cards. Do not invent facts the cards don't support.
2. Phrase questions in different language than the cards. Test understanding (apply, contrast, predict) not memorization of phrasing.
3. Multiple choice: exactly 4 options, one correct, three plausible distractors. Distractors should sound right but be wrong — pull from related concepts in the OTHER source cards, not random nonsense.
4. Free response: include an "expectedAnswer" with a 1-3 sentence model answer derived from the cards.
5. Each question MUST cite the source notes (sourceNoteIds) it derives from — use the noteId values shown in the source block.
6. Mix of question types: ${typeMix}.
7. Difficulty: ${difficultyHint}.
8. Output ONLY a single valid JSON object matching this schema. No prose, no markdown fences. Just the JSON.

JSON schema:
{
  "questions": [
    {
      "type": "mcq" | "free",
      "prompt": "string",
      "choices": ["string", "string", "string", "string"],   // mcq only, exactly 4
      "correctIndex": 0,                                       // mcq only, 0..3
      "expectedAnswer": "string",                              // free only
      "sourceNoteIds": ["string", ...]
    }
  ]
}`;

  const resp = await client.messages.create(
    {
      model,
      max_tokens: 4096,
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: `Produce ${count} questions now. Output JSON only.`,
        },
      ],
    },
    { signal: signal as AbortSignal },
  );

  const text = resp.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  return parseAndValidate(text, notes);
}

function describeMix(types: ExamQuestionType[]): string {
  if (types.length === 0 || (types.includes('mcq') && !types.includes('free'))) {
    return 'all multiple choice';
  }
  if (types.includes('free') && !types.includes('mcq')) return 'all free response';
  return 'roughly 70% multiple choice, 30% free response';
}

function describeDifficulty(d: ExamDifficulty): string {
  switch (d) {
    case 'match': return 'match the cards (recall + light application)';
    case 'harder': return 'harder than the cards — require synthesis across multiple cards, two-step reasoning, or distinguishing similar concepts';
    case 'easier': return 'easier than the cards — straightforward recall of the central fact';
  }
}

function formatNoteForPrompt(n: Note): string {
  const front = renderPlain(n.fields.front || '').trim();
  const back = (n.fields.back || '').trim();
  const extra = (n.fields.extra || '').trim();
  const context = (n.fields.context || '').trim();
  const tagLine = n.tags.length > 0 ? `\n  tags: ${n.tags.join(', ')}` : '';
  return [
    `[noteId: ${n.id}]`,
    `  front: ${front}`,
    back ? `  back: ${back}` : '',
    extra ? `  extra: ${extra}` : '',
    context ? `  context: ${context}` : '',
    tagLine,
  ].filter(Boolean).join('\n');
}

interface RawQuestion {
  type?: string;
  prompt?: string;
  choices?: unknown;
  correctIndex?: unknown;
  expectedAnswer?: unknown;
  sourceNoteIds?: unknown;
}

function parseAndValidate(raw: string, notes: Note[]): GeneratedQ[] {
  const validIds = new Set(notes.map(n => n.id));
  const json = extractJson(raw);
  let parsed: { questions?: RawQuestion[] };
  try {
    parsed = JSON.parse(json);
  } catch {
    // Sometimes the model wraps JSON in fences despite instructions.
    parsed = JSON.parse(stripFences(json));
  }
  const arr = Array.isArray(parsed.questions) ? parsed.questions : [];
  const out: GeneratedQ[] = [];
  for (const q of arr) {
    const validated = validateQ(q, validIds);
    if (validated) out.push(validated);
  }
  return out;
}

function validateQ(q: RawQuestion, validIds: Set<string>): GeneratedQ | null {
  if (typeof q.prompt !== 'string' || !q.prompt.trim()) return null;
  const ids = Array.isArray(q.sourceNoteIds)
    ? (q.sourceNoteIds.filter(x => typeof x === 'string' && validIds.has(x)) as string[])
    : [];
  if (q.type === 'mcq') {
    if (!Array.isArray(q.choices) || q.choices.length !== 4) return null;
    if (!q.choices.every(c => typeof c === 'string')) return null;
    const ci = typeof q.correctIndex === 'number' ? q.correctIndex : -1;
    if (ci < 0 || ci > 3) return null;
    return {
      type: 'mcq',
      prompt: q.prompt.trim(),
      choices: (q.choices as string[]).map(c => c.trim()),
      correctIndex: ci,
      sourceNoteIds: ids,
    };
  }
  if (q.type === 'free') {
    const exp = typeof q.expectedAnswer === 'string' ? q.expectedAnswer.trim() : '';
    if (!exp) return null;
    return {
      type: 'free',
      prompt: q.prompt.trim(),
      expectedAnswer: exp,
      sourceNoteIds: ids,
    };
  }
  return null;
}

function extractJson(s: string): string {
  // Pull the outermost { ... } block out of any prose wrapping the model
  // might add despite instructions.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return s;
  return s.slice(start, end + 1);
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
}

function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Grade a free-response answer with Claude. Returns a score 0..1 and a short
 * markdown feedback paragraph. Used after the user submits the exam.
 */
export async function gradeFreeResponse(
  question: ExamQuestion,
  notes: Note[],
): Promise<{ score: number; feedback: string }> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const sourceCards = notes
    .filter(n => question.sourceNoteIds.includes(n.id))
    .map(formatNoteForPrompt).join('\n\n---\n\n');

  const system = `You are a fair, calibrated exam grader. Grade the user's free-response answer against the expected answer and the source flashcards.

Rules:
1. Score is a number from 0 to 1. 1 = fully correct on the central point. 0.7 = mostly right with a minor gap. 0.4 = partial credit, missed core. 0 = wrong or empty.
2. Feedback is one short markdown paragraph: what was right, what was missing, and the corrected answer if needed. Be terse and direct.
3. Output ONLY JSON: { "score": number, "feedback": "string" }. No prose, no fences.

Source flashcards:

${sourceCards}

Question prompt:
${question.prompt}

Expected answer:
${question.expectedAnswer ?? '(none)'}`;

  const resp = await client.messages.create({
    model,
    max_tokens: 512,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `User's answer: ${question.userAnswer || '(empty)'}\n\nGrade now.`,
      },
    ],
  });

  const text = resp.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');
  const json = extractJson(text);
  let parsed: { score?: unknown; feedback?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = JSON.parse(stripFences(json));
  }
  const score = typeof parsed.score === 'number' ? clamp01(parsed.score) : 0;
  const feedback = typeof parsed.feedback === 'string' ? parsed.feedback : '';
  return { score, feedback };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function buildExamTitle(deckName: string, config: ExamConfig): string {
  const date = new Date().toISOString().slice(0, 10);
  const leaf = deckName.split('::').slice(-1)[0]?.trim() || deckName;
  const cov = config.coverage.kind === 'lapses' ? ' lapses'
    : config.coverage.kind === 'tags' ? ` tags`
    : '';
  return `${leaf} — ${config.count}Q${cov} (${date})`;
}
