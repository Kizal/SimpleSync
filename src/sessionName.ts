const WORDS: string[] = [
  'TIGER', 'BLUE', 'HAWK', 'STORM', 'PIXEL',
  'NOVA', 'SWIFT', 'IRON', 'CLOUD', 'FIRE',
];

/** Generates a human-readable session name like "TIGER-7" or "BLUE-4". */
export function generateSessionName(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const number = Math.floor(Math.random() * 9) + 1;
  return `${word}-${number}`;
}
