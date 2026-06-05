export type GameId = 'MI1' | 'MI2';

export interface DetectedGame {
  gameId: GameId;
  displayName: string;
}

const MI1_FILES = ['MONKEY.000', 'MONKEY.001'];
const MI2_FILES = ['MONKEY2.000', 'MONKEY2.001'];

export function detectGame(filenames: readonly string[]): DetectedGame | null {
  const upper = new Set(filenames.map((n) => n.toUpperCase()));

  if (MI1_FILES.every((f) => upper.has(f))) {
    return { gameId: 'MI1', displayName: 'The Secret of Monkey Island' };
  }
  if (MI2_FILES.every((f) => upper.has(f))) {
    return { gameId: 'MI2', displayName: "Monkey Island 2: LeChuck's Revenge" };
  }
  return null;
}
