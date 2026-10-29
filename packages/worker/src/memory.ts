import { uuidv7 } from "@infuture/events";

export type MemoryItem = {
  id: string;
  workspaceId: string;
  role: string;
  content: string;
  tags: string[];
  importance: number;
  runId?: string;
  createdAt: Date;
};

export type KnowledgeChunk = {
  id: string;
  text: string;
  keywords: string[];
  tokenEstimate: number;
};

export type KnowledgeDocument = {
  id: string;
  workspaceId: string;
  title: string;
  category: string;
  content: string;
  chunks: KnowledgeChunk[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type ScoredKnowledgeResult = {
  documentId: string;
  title: string;
  category: string;
  chunkId: string;
  text: string;
  score: number;
  matchedKeywords: string[];
};

const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "aren't",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "did",
  "didn't",
  "do",
  "does",
  "doesn't",
  "doing",
  "don't",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "hadn't",
  "has",
  "hasn't",
  "have",
  "haven't",
  "having",
  "he",
  "he'd",
  "he'll",
  "he's",
  "her",
  "here",
  "here's",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "how's",
  "i",
  "i'd",
  "i'll",
  "i'm",
  "i've",
  "if",
  "in",
  "into",
  "is",
  "isn't",
  "it",
  "it's",
  "its",
  "itself",
  "let's",
  "me",
  "more",
  "most",
  "mustn't",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "shan't",
  "she",
  "she'd",
  "she'll",
  "she's",
  "should",
  "shouldn't",
  "so",
  "some",
  "such",
  "than",
  "that",
  "that's",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "there's",
  "these",
  "they",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "wasn't",
  "we",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "were",
  "weren't",
  "what",
  "what's",
  "when",
  "when's",
  "where",
  "where's",
  "which",
  "while",
  "who",
  "who's",
  "whom",
  "why",
  "why's",
  "with",
  "won't",
  "would",
  "wouldn't",
  "you",
  "you'd",
  "you'll",
  "you're",
  "you've",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "de",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "y",
  "o",
  "en",
  "para",
  "por",
  "con",
  "sin",
  "sobre",
  "del",
  "al",
  "que",
  "se",
  "es",
  "son",
]);

/**
 * Extract normalized keywords from raw string text.
 */
export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

/**
 * Split text into semantic passages of approx. 150-250 words with keyword tagging.
 */
export function chunkText(content: string, maxChunkWords = 150): KnowledgeChunk[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: KnowledgeChunk[] = [];
  let currentBuffer: string[] = [];
  let currentWordCount = 0;

  for (const para of paragraphs) {
    const words = para.split(/\s+/);
    if (currentWordCount + words.length > maxChunkWords && currentBuffer.length > 0) {
      const chunkText = currentBuffer.join("\n\n");
      chunks.push({
        id: uuidv7(),
        text: chunkText,
        keywords: extractKeywords(chunkText),
        tokenEstimate: Math.ceil(chunkText.length / 4),
      });
      currentBuffer = [];
      currentWordCount = 0;
    }
    currentBuffer.push(para);
    currentWordCount += words.length;
  }

  if (currentBuffer.length > 0) {
    const chunkText = currentBuffer.join("\n\n");
    chunks.push({
      id: uuidv7(),
      text: chunkText,
      keywords: extractKeywords(chunkText),
      tokenEstimate: Math.ceil(chunkText.length / 4),
    });
  }

  if (chunks.length === 0 && content.trim()) {
    chunks.push({
      id: uuidv7(),
      text: content.trim(),
      keywords: extractKeywords(content),
      tokenEstimate: Math.ceil(content.length / 4),
    });
  }

  return chunks;
}

/**
 * Calculates a relevance score (0.0 to 1.0) between a query and a chunk using term overlap and keyword weighting.
 */
export function scoreChunkRelevance(
  query: string,
  chunk: KnowledgeChunk,
): { score: number; matchedKeywords: string[] } {
  const queryKeywords = extractKeywords(query);
  if (queryKeywords.length === 0) return { score: 0, matchedKeywords: [] };

  const chunkKeywordSet = new Set(chunk.keywords);
  const matched = queryKeywords.filter((k) => chunkKeywordSet.has(k));

  if (matched.length === 0) {
    // Check partial substring match as fallback
    const lowerText = chunk.text.toLowerCase();
    const partialMatches = queryKeywords.filter((k) => lowerText.includes(k));
    if (partialMatches.length > 0) {
      const score = (partialMatches.length / queryKeywords.length) * 0.45;
      return { score: Number(score.toFixed(3)), matchedKeywords: partialMatches };
    }
    return { score: 0, matchedKeywords: [] };
  }

  // Exact keyword overlap ratio
  const ratio = matched.length / queryKeywords.length;
  // Frequency density boost
  let occurrences = 0;
  const lowerText = chunk.text.toLowerCase();
  for (const kw of matched) {
    const regex = new RegExp(`\\b${kw}\\b`, "g");
    occurrences += (lowerText.match(regex) || []).length;
  }
  const density = Math.min(occurrences * 0.05, 0.25);
  const rawScore = Math.min(0.65 * ratio + density + 0.1, 1.0);

  return {
    score: Number(rawScore.toFixed(3)),
    matchedKeywords: matched,
  };
}

/**
 * Hybrid search over a collection of knowledge documents.
 */
export function searchKnowledgeDocuments(
  documents: KnowledgeDocument[],
  query: string,
  options: { category?: string; limit?: number; minScore?: number } = {},
): ScoredKnowledgeResult[] {
  const { category, limit = 5, minScore = 0.15 } = options;
  const results: ScoredKnowledgeResult[] = [];

  for (const doc of documents) {
    if (category && category !== "all" && doc.category.toLowerCase() !== category.toLowerCase()) {
      continue;
    }
    for (const chunk of doc.chunks) {
      const { score, matchedKeywords } = scoreChunkRelevance(query, chunk);
      if (score >= minScore) {
        results.push({
          documentId: doc.id,
          title: doc.title,
          category: doc.category,
          chunkId: chunk.id,
          text: chunk.text,
          score,
          matchedKeywords,
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Search and rank memories by query, role match, and importance weight.
 */
export function searchWorkspaceMemories(
  memories: MemoryItem[],
  query: string,
  options: { role?: string; limit?: number } = {},
): Array<MemoryItem & { score: number }> {
  const { role, limit = 10 } = options;
  const queryKeywords = extractKeywords(query);

  const scored: Array<MemoryItem & { score: number }> = [];

  for (const mem of memories) {
    if (role && role !== "all" && mem.role !== "all" && mem.role !== role) {
      continue;
    }

    let baseScore = 0.2; // Baseline prior
    if (queryKeywords.length > 0) {
      const memKeywords = new Set([...extractKeywords(mem.content), ...mem.tags.map((t) => t.toLowerCase())]);
      const matched = queryKeywords.filter((k) => memKeywords.has(k));
      if (matched.length > 0) {
        baseScore = 0.4 + (matched.length / queryKeywords.length) * 0.4;
      } else {
        const lower = mem.content.toLowerCase();
        if (queryKeywords.some((k) => lower.includes(k))) {
          baseScore = 0.3;
        } else {
          baseScore = 0.05;
        }
      }
    }

    // Weight by importance (1 to 5)
    const importanceMultiplier = 1 + (mem.importance - 1) * 0.15;
    const finalScore = Number(Math.min(baseScore * importanceMultiplier, 1.0).toFixed(3));

    if (finalScore >= 0.1) {
      scored.push({
        ...mem,
        score: finalScore,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ----------------------------- In-Memory Stores ----------------------------- */

const memoryStoreByWorkspace = new Map<string, Map<string, MemoryItem>>();
const knowledgeStoreByWorkspace = new Map<string, Map<string, KnowledgeDocument>>();

export function getWorkspaceMemoriesMap(workspaceId: string): Map<string, MemoryItem> {
  let store = memoryStoreByWorkspace.get(workspaceId);
  if (!store) {
    store = new Map<string, MemoryItem>();
    memoryStoreByWorkspace.set(workspaceId, store);
    seedInitialMemories(workspaceId, store);
  }
  return store;
}

export function getWorkspaceKnowledgeMap(workspaceId: string): Map<string, KnowledgeDocument> {
  let store = knowledgeStoreByWorkspace.get(workspaceId);
  if (!store) {
    store = new Map<string, KnowledgeDocument>();
    knowledgeStoreByWorkspace.set(workspaceId, store);
    seedInitialKnowledge(workspaceId, store);
  }
  return store;
}

function seedInitialMemories(workspaceId: string, store: Map<string, MemoryItem>) {
  const m1: MemoryItem = {
    id: "mem-zero-trust-keys",
    workspaceId,
    role: "developer",
    content:
      "Envelope encryption with AES-256-GCM is strictly enforced for all LLM API keys. Keys are decrypted only at call time and never logged.",
    tags: ["security", "vault", "encryption"],
    importance: 5,
    createdAt: new Date(),
  };

  const m2: MemoryItem = {
    id: "mem-multiagent-pipeline",
    workspaceId,
    role: "supervisor",
    content:
      "Multi-agent tasks must decompose into sequential or parallel subtasks: Planning (Supervisor) -> Gathering (Researcher) -> Building (Developer) -> Quality Audit (Reviewer).",
    tags: ["architecture", "multiagent", "orchestration"],
    importance: 4,
    createdAt: new Date(),
  };

  const m3: MemoryItem = {
    id: "mem-strict-i18n",
    workspaceId,
    role: "all",
    content:
      "All user-facing messages, responses, and events must support both English and Spanish with identical variable placeholders (e.g. {{name}}).",
    tags: ["i18n", "standards", "compliance"],
    importance: 4,
    createdAt: new Date(),
  };

  store.set(m1.id, m1);
  store.set(m2.id, m2);
  store.set(m3.id, m3);
}

function seedInitialKnowledge(workspaceId: string, store: Map<string, KnowledgeDocument>) {
  const doc1Content = `# Zero Trust Architecture & API Security Standards
Zero Trust Architecture (NIST SP 800-207) operates under the principle of 'never trust, always verify'.
Every API request, agent invocation, and database query must authenticate explicitly and enforce least privilege.

## Secret Management & Envelope Encryption
1. Master keys are kept in environment variables or hardware security modules (HSMs).
2. Data Encryption Keys (DEKs) encrypt credentials using AES-256-GCM with unique 96-bit initialization vectors.
3. Plaintext keys are wiped from memory immediately after dispatching the HTTP request.`;

  const doc1: KnowledgeDocument = {
    id: "kb-zero-trust",
    workspaceId,
    title: "Zero Trust Architecture & Security Standards",
    category: "architecture",
    content: doc1Content,
    chunks: chunkText(doc1Content),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const doc2Content = `# Autonomous Multi-Agent Team Collaboration Specification
In complex problem-solving, single agents suffer from compounding error rates and context degradation.
The infuture IA team pipeline introduces specialized personas coordinated through an immutable event ledger.

## Roles and Responsibilities
- Supervisor: Strategic decomposition, milestone tracking, and task delegation.
- Researcher: Information retrieval, documentation scraping, and empirical verification.
- Developer: Systems engineering, algorithm design, and executable tool authoring.
- Reviewer: Blind critique, sanity check, and verification against constraints.`;

  const doc2: KnowledgeDocument = {
    id: "kb-multiagent-spec",
    workspaceId,
    title: "Multi-Agent Team Collaboration Specification",
    category: "specifications",
    content: doc2Content,
    chunks: chunkText(doc2Content),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  store.set(doc1.id, doc1);
  store.set(doc2.id, doc2);
}
