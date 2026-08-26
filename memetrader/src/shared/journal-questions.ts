export interface JournalQuestion {
  id: string;
  prompt: string;
  /** `text` renders a textarea, `yesno` renders a two-state toggle. */
  kind: 'text' | 'yesno';
}

export const PRE_TRADE_QUESTIONS: JournalQuestion[] = [
  { id: 'why', prompt: 'Why am I entering?', kind: 'text' },
  { id: 'setup', prompt: 'What is the setup?', kind: 'text' },
  { id: 'invalidation', prompt: 'What invalidates the setup?', kind: 'text' },
  { id: 'max_loss', prompt: 'What is my maximum loss?', kind: 'text' },
  { id: 'target', prompt: 'What is my target?', kind: 'text' },
  {
    id: 'defined_setup',
    prompt: 'Am I entering because of a defined setup, or because of FOMO?',
    kind: 'text',
  },
];

export const POST_TRADE_QUESTIONS: JournalQuestion[] = [
  { id: 'followed_plan', prompt: 'Did I follow the plan?', kind: 'yesno' },
  { id: 'moved_stop', prompt: 'Did I move my stop?', kind: 'yesno' },
  { id: 'chased', prompt: 'Did I chase?', kind: 'yesno' },
  { id: 'revenge', prompt: 'Did I revenge trade?', kind: 'yesno' },
  { id: 'exited_early', prompt: 'Did I exit early?', kind: 'yesno' },
  { id: 'ignored_setup', prompt: 'Did I ignore my setup?', kind: 'yesno' },
  { id: 'lesson', prompt: 'What is the one lesson from this trade?', kind: 'text' },
];

export const GRADES = ['A', 'B', 'C', 'D', 'F'] as const;
