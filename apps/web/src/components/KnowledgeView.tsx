import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "@infuture/i18n";
import { useLocale } from "../i18n";

export type KnowledgeDocItem = {
  id: string;
  title: string;
  category: string;
  chunksCount: number;
  totalTokensEstimate: number;
  preview: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AgentMemoryItem = {
  id: string;
  role: string;
  content: string;
  tags: string[];
  importance: number;
  runId?: string;
  createdAt: string;
};

export type SearchResultChunk = {
  documentId: string;
  title: string;
  category: string;
  chunkId: string;
  text: string;
  score: number;
  matchedKeywords: string[];
};

export function KnowledgeView() {
  const { t } = useTranslation();
  const locale = useLocale();

  const [activeSubTab, setActiveSubTab] = useState<"knowledge" | "memory">("knowledge");

  // Knowledge Documents & RAG state
  const [documents, setDocuments] = useState<KnowledgeDocItem[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResultChunk[] | null>(null);

  // Ingest modal
  const [isIngesting, setIsIngesting] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocCategory, setNewDocCategory] = useState("architecture");
  const [newDocContent, setNewDocContent] = useState("");
  const [savingDoc, setSavingDoc] = useState(false);

  // Memory Bank state
  const [memories, setMemories] = useState<AgentMemoryItem[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [roleFilter, setRoleFilter] = useState("all");
  const [memorySearchQuery, setMemorySearchQuery] = useState("");

  // Record Memory modal
  const [isRecordingMemory, setIsRecordingMemory] = useState(false);
  const [newMemoryContent, setNewMemoryContent] = useState("");
  const [newMemoryRole, setNewMemoryRole] = useState("all");
  const [newMemoryTags, setNewMemoryTags] = useState("");
  const [newMemoryImportance, setNewMemoryImportance] = useState(3);
  const [savingMemory, setSavingMemory] = useState(false);

  // Status notification
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    try {
      setLoadingDocs(true);
      const url =
        categoryFilter && categoryFilter !== "all"
          ? `/api/v1/knowledge?category=${encodeURIComponent(categoryFilter)}`
          : "/api/v1/knowledge";
      const res = await fetch(url, { headers: { "X-Infuture-Locale": locale } });
      if (res.ok) {
        const data = (await res.json()) as KnowledgeDocItem[];
        setDocuments(data);
      }
    } catch {
      // ignore
    } finally {
      setLoadingDocs(false);
    }
  }, [categoryFilter, locale]);

  const loadMemories = useCallback(async () => {
    try {
      setLoadingMemories(true);
      const params = new URLSearchParams();
      if (roleFilter && roleFilter !== "all") params.set("role", roleFilter);
      if (memorySearchQuery.trim()) params.set("q", memorySearchQuery.trim());
      const url = `/api/v1/memory${params.toString() ? `?${params.toString()}` : ""}`;
      const res = await fetch(url, { headers: { "X-Infuture-Locale": locale } });
      if (res.ok) {
        const data = (await res.json()) as AgentMemoryItem[];
        setMemories(data);
      }
    } catch {
      // ignore
    } finally {
      setLoadingMemories(false);
    }
  }, [roleFilter, memorySearchQuery, locale]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  // Handle RAG Semantic Search
  const handlePerformSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    try {
      setIsSearching(true);
      const res = await fetch("/api/v1/knowledge/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
        body: JSON.stringify({
          query: searchQuery.trim(),
          category: categoryFilter !== "all" ? categoryFilter : undefined,
          limit: 5,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { results: SearchResultChunk[] };
        setSearchResults(data.results);
      }
    } catch {
      // ignore
    } finally {
      setIsSearching(false);
    }
  };

  // Handle Document Ingestion
  const handleIngestDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocTitle.trim() || !newDocContent.trim()) return;
    try {
      setSavingDoc(true);
      const res = await fetch("/api/v1/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
        body: JSON.stringify({
          title: newDocTitle.trim(),
          category: newDocCategory,
          content: newDocContent.trim(),
        }),
      });
      if (res.ok) {
        setIsIngesting(false);
        setNewDocTitle("");
        setNewDocContent("");
        setStatusMessage(t("knowledgeView.ingestedSuccess"));
        setTimeout(() => setStatusMessage(null), 3000);
        await loadDocuments();
      }
    } catch {
      // ignore
    } finally {
      setSavingDoc(false);
    }
  };

  // Handle Delete Document
  const handleDeleteDocument = async (id: string, title: string) => {
    if (!window.confirm(t("knowledgeView.confirmDeleteDoc", { title }))) return;
    try {
      const res = await fetch(`/api/v1/knowledge/${id}`, {
        method: "DELETE",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok) {
        setStatusMessage(t("knowledgeView.deletedDocSuccess"));
        setTimeout(() => setStatusMessage(null), 3000);
        await loadDocuments();
        if (searchResults) handlePerformSearch();
      }
    } catch {
      // ignore
    }
  };

  // Handle Record Memory
  const handleRecordMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemoryContent.trim()) return;
    try {
      setSavingMemory(true);
      const tags = newMemoryTags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/v1/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
        body: JSON.stringify({
          content: newMemoryContent.trim(),
          role: newMemoryRole,
          tags,
          importance: newMemoryImportance,
        }),
      });
      if (res.ok) {
        setIsRecordingMemory(false);
        setNewMemoryContent("");
        setNewMemoryTags("");
        setNewMemoryImportance(3);
        setStatusMessage(t("knowledgeView.memoryRecordedSuccess"));
        setTimeout(() => setStatusMessage(null), 3000);
        await loadMemories();
      }
    } catch {
      // ignore
    } finally {
      setSavingMemory(false);
    }
  };

  // Handle Delete Memory
  const handleDeleteMemory = async (id: string) => {
    if (!window.confirm(t("knowledgeView.confirmDeleteMemory"))) return;
    try {
      const res = await fetch(`/api/v1/memory/${id}`, {
        method: "DELETE",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok) {
        setStatusMessage(t("knowledgeView.memoryDeletedSuccess"));
        setTimeout(() => setStatusMessage(null), 3000);
        await loadMemories();
      }
    } catch {
      // ignore
    }
  };

  return (
    <div className="knowledge-page">
      {/* Page Header */}
      <div className="knowledge-header">
        <div className="knowledge-title-group">
          <h2>{t("knowledgeView.title")}</h2>
          <p className="knowledge-subtitle">{t("knowledgeView.subtitle")}</p>
        </div>

        <div className="knowledge-top-actions">
          <div className="knowledge-subtabs" role="tablist">
            <button
              type="button"
              className={`knowledge-subtab-btn ${activeSubTab === "knowledge" ? "active" : ""}`}
              onClick={() => setActiveSubTab("knowledge")}
            >
              {t("knowledgeView.tabKnowledge")}
            </button>
            <button
              type="button"
              className={`knowledge-subtab-btn ${activeSubTab === "memory" ? "active" : ""}`}
              onClick={() => setActiveSubTab("memory")}
            >
              {t("knowledgeView.tabMemory")}
            </button>
          </div>

          {activeSubTab === "knowledge" ? (
            <button type="button" className="btn btn-primary" onClick={() => setIsIngesting(true)}>
              + {t("knowledgeView.ingestDocument")}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setIsRecordingMemory(true)}>
              + {t("knowledgeView.recordMemory")}
            </button>
          )}
        </div>
      </div>

      {statusMessage && <div className="alert-banner alert-success">{statusMessage}</div>}

      {/* TAB 1: KNOWLEDGE BASE & RAG RETRIEVAL */}
      {activeSubTab === "knowledge" && (
        <div className="knowledge-content-layout">
          {/* RAG Retrieval Search Card */}
          <div className="rag-search-card">
            <div className="rag-card-header">
              <h4>{t("knowledgeView.ragSearchTitle")}</h4>
              <p>{t("knowledgeView.ragSearchSubtitle")}</p>
            </div>

            <form onSubmit={handlePerformSearch} className="rag-search-form">
              <div className="rag-input-row">
                <input
                  type="text"
                  className="input search-input"
                  placeholder={t("knowledgeView.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <select
                  className="input category-select"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                >
                  <option value="all">{t("knowledgeView.categoryAll")}</option>
                  <option value="architecture">{t("knowledgeView.catArchitecture")}</option>
                  <option value="specifications">{t("knowledgeView.catSpecs")}</option>
                  <option value="engineering">{t("knowledgeView.catEngineering")}</option>
                  <option value="general">{t("knowledgeView.catGeneral")}</option>
                </select>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSearching || !searchQuery.trim()}
                >
                  {isSearching ? t("knowledgeView.searching") : t("knowledgeView.searchBtn")}
                </button>
                {searchResults && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setSearchQuery("");
                      setSearchResults(null);
                    }}
                  >
                    {t("knowledgeView.clearSearch")}
                  </button>
                )}
              </div>
            </form>

            {/* RAG Scored Results Stream */}
            {searchResults && (
              <div className="rag-results-container">
                <div className="rag-results-header">
                  <span className="results-count">
                    {t("knowledgeView.resultsFound", { count: searchResults.length })}
                  </span>
                </div>
                {searchResults.length === 0 ? (
                  <div className="empty-results-box">
                    <p>{t("knowledgeView.noMatchesFound")}</p>
                  </div>
                ) : (
                  <div className="rag-results-list">
                    {searchResults.map((r, idx) => (
                      <div key={`${r.chunkId}-${idx}`} className="rag-result-card">
                        <div className="result-card-top">
                          <span className="doc-source-title">{r.title}</span>
                          <div className="result-meta-tags">
                            <span className="category-pill">{r.category}</span>
                            <span className="score-pill">
                              {Math.round(r.score * 100)}% {t("knowledgeView.relevance")}
                            </span>
                          </div>
                        </div>
                        <p className="result-chunk-text">{r.text}</p>
                        {r.matchedKeywords.length > 0 && (
                          <div className="matched-keywords-row">
                            <span className="matched-label">{t("knowledgeView.matchedTerms")}:</span>
                            {r.matchedKeywords.map((kw) => (
                              <span key={kw} className="keyword-chip">
                                {kw}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Ingested Documents List */}
          <div className="documents-section">
            <div className="section-title-row">
              <h3>
                {t("knowledgeView.documentsHeader")} ({documents.length})
              </h3>
            </div>

            {loadingDocs ? (
              <p className="muted">{t("common.loading")}</p>
            ) : documents.length === 0 ? (
              <div className="empty-docs-box">
                <p>{t("knowledgeView.noDocs")}</p>
              </div>
            ) : (
              <div className="docs-grid">
                {documents.map((doc) => (
                  <div key={doc.id} className="document-card">
                    <div className="doc-card-head">
                      <span className="doc-title">{doc.title}</span>
                      <span className="category-pill">{doc.category}</span>
                    </div>

                    <p className="doc-preview">{doc.preview}...</p>

                    <div className="doc-card-footer">
                      <div className="doc-stats">
                        <span>{t("knowledgeView.chunksCount", { chunks: doc.chunksCount })}</span>
                        <span className="dot-sep">•</span>
                        <span>~{doc.totalTokensEstimate} tokens</span>
                      </div>
                      <button
                        type="button"
                        className="btn-delete-chip"
                        title={t("knowledgeView.deleteDoc")}
                        onClick={() => handleDeleteDocument(doc.id, doc.title)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: AGENT MEMORY BANK */}
      {activeSubTab === "memory" && (
        <div className="memory-content-layout">
          {/* Filter Bar */}
          <div className="memory-filters-card">
            <div className="filter-field">
              <label htmlFor="mem-q">{t("knowledgeView.filterMemory")}:</label>
              <input
                id="mem-q"
                type="text"
                className="input"
                placeholder={t("knowledgeView.searchMemoriesPlaceholder")}
                value={memorySearchQuery}
                onChange={(e) => setMemorySearchQuery(e.target.value)}
              />
            </div>
            <div className="filter-field">
              <label htmlFor="mem-role">{t("knowledgeView.filterRole")}:</label>
              <select
                id="mem-role"
                className="input"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
              >
                <option value="all">{t("knowledgeView.allRoles")}</option>
                <option value="supervisor">Supervisor</option>
                <option value="researcher">Researcher</option>
                <option value="analyst">Analyst</option>
                <option value="developer">Developer</option>
                <option value="writer">Writer</option>
                <option value="reviewer">Reviewer</option>
                <option value="receptionist">Receptionist</option>
              </select>
            </div>
          </div>

          {/* Memory Items Grid */}
          {loadingMemories ? (
            <p className="muted">{t("common.loading")}</p>
          ) : memories.length === 0 ? (
            <div className="empty-memories-box">
              <p>{t("knowledgeView.noMemories")}</p>
            </div>
          ) : (
            <div className="memories-grid">
              {memories.map((mem) => (
                <div key={mem.id} className="memory-card">
                  <div className="memory-card-header">
                    <span className="memory-role-badge">@{mem.role}</span>
                    <div className="memory-importance-stars" title={`Importance: ${mem.importance}/5`}>
                      {"★".repeat(mem.importance)}
                      {"☆".repeat(5 - mem.importance)}
                    </div>
                  </div>

                  <p className="memory-content">{mem.content}</p>

                  <div className="memory-tags-row">
                    {mem.tags.map((t) => (
                      <span key={t} className="memory-tag-chip">
                        #{t}
                      </span>
                    ))}
                  </div>

                  <div className="memory-card-footer">
                    <span className="memory-date">
                      {formatDateTime(locale, new Date(mem.createdAt).getTime())}
                    </span>
                    <button
                      type="button"
                      className="btn-delete-chip"
                      title={t("knowledgeView.deleteMemory")}
                      onClick={() => handleDeleteMemory(mem.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* MODAL 1: INGEST KNOWLEDGE DOCUMENT */}
      {isIngesting && (
        <div className="modal-backdrop" onClick={() => setIsIngesting(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("knowledgeView.ingestModalTitle")}</h3>
              <button type="button" className="btn-icon" onClick={() => setIsIngesting(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleIngestDocument} className="modal-form">
              <div className="field-group">
                <label htmlFor="doc-title">{t("knowledgeView.docTitleLabel")}</label>
                <input
                  id="doc-title"
                  type="text"
                  required
                  className="input"
                  placeholder="e.g. Microservices Reliability Guidelines"
                  value={newDocTitle}
                  onChange={(e) => setNewDocTitle(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label htmlFor="doc-cat">{t("knowledgeView.docCategoryLabel")}</label>
                <select
                  id="doc-cat"
                  className="input"
                  value={newDocCategory}
                  onChange={(e) => setNewDocCategory(e.target.value)}
                >
                  <option value="architecture">Architecture</option>
                  <option value="specifications">Specifications</option>
                  <option value="engineering">Engineering</option>
                  <option value="general">General</option>
                </select>
              </div>

              <div className="field-group">
                <label htmlFor="doc-content">{t("knowledgeView.docContentLabel")}</label>
                <textarea
                  id="doc-content"
                  rows={8}
                  required
                  className="prompt-textarea mono"
                  placeholder="# Document Title&#10;&#10;Enter markdown or documentation text..."
                  value={newDocContent}
                  onChange={(e) => setNewDocContent(e.target.value)}
                />
              </div>

              <div className="modal-actions-row">
                <button type="button" className="btn btn-secondary" onClick={() => setIsIngesting(false)}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingDoc}>
                  {savingDoc ? t("common.saving") : t("knowledgeView.ingestBtn")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: RECORD AGENT MEMORY */}
      {isRecordingMemory && (
        <div className="modal-backdrop" onClick={() => setIsRecordingMemory(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("knowledgeView.recordMemoryModalTitle")}</h3>
              <button type="button" className="btn-icon" onClick={() => setIsRecordingMemory(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleRecordMemory} className="modal-form">
              <div className="field-group">
                <label htmlFor="mem-content">{t("knowledgeView.memoryContentLabel")}</label>
                <textarea
                  id="mem-content"
                  rows={4}
                  required
                  className="input"
                  placeholder="Enter the core fact, insight, or architectural decision to retain..."
                  value={newMemoryContent}
                  onChange={(e) => setNewMemoryContent(e.target.value)}
                />
              </div>

              <div className="modal-fields-grid">
                <div className="field-group">
                  <label htmlFor="mem-target-role">{t("knowledgeView.targetRoleLabel")}</label>
                  <select
                    id="mem-target-role"
                    className="input"
                    value={newMemoryRole}
                    onChange={(e) => setNewMemoryRole(e.target.value)}
                  >
                    <option value="all">All Roles</option>
                    <option value="supervisor">Supervisor</option>
                    <option value="researcher">Researcher</option>
                    <option value="analyst">Analyst</option>
                    <option value="developer">Developer</option>
                    <option value="writer">Writer</option>
                    <option value="reviewer">Reviewer</option>
                    <option value="receptionist">Receptionist</option>
                  </select>
                </div>

                <div className="field-group">
                  <label htmlFor="mem-importance">{t("knowledgeView.importanceLabel")}</label>
                  <select
                    id="mem-importance"
                    className="input"
                    value={newMemoryImportance}
                    onChange={(e) => setNewMemoryImportance(Number(e.target.value))}
                  >
                    <option value={1}>1 - Low / Background Fact</option>
                    <option value={2}>2 - Standard Observation</option>
                    <option value={3}>3 - Important Guideline</option>
                    <option value={4}>4 - High Priority Rule</option>
                    <option value={5}>5 - Critical Constraint</option>
                  </select>
                </div>
              </div>

              <div className="field-group">
                <label htmlFor="mem-tags">{t("knowledgeView.tagsLabel")}</label>
                <input
                  id="mem-tags"
                  type="text"
                  className="input"
                  placeholder="security, architecture, compliance"
                  value={newMemoryTags}
                  onChange={(e) => setNewMemoryTags(e.target.value)}
                />
              </div>

              <div className="modal-actions-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsRecordingMemory(false)}
                >
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingMemory}>
                  {savingMemory ? t("common.saving") : t("knowledgeView.saveMemoryBtn")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
