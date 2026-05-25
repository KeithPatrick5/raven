export type WatchlistItem = {
  symbol: string;
  focus: string;
  lastSignal: string;
  status: string;
  score: string;
};

export const watchlist: WatchlistItem[] = [
  { symbol: "TSLA", focus: "8-K / delivery risk", lastSignal: "SEC scanner ready", status: "Watching", score: "--" },
  { symbol: "PLTR", focus: "contract language", lastSignal: "SEC scanner ready", status: "Watching", score: "--" },
  { symbol: "SOFI", focus: "earnings / guidance", lastSignal: "SEC scanner ready", status: "Watching", score: "--" },
  { symbol: "DNA", focus: "dilution traps", lastSignal: "SEC scanner ready", status: "Watching", score: "--" },
  { symbol: "IONQ", focus: "hype vs filings", lastSignal: "SEC scanner ready", status: "Watching", score: "--" }
];
