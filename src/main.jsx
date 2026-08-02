import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import {
  Bot,
  Braces,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronLeft,
  ChevronRight,
  Clock,
  Folder,
  Hammer,
  Info,
  RefreshCw,
  Search,
  Terminal,
  User,
  Users,
  Menu,
  X,
} from "lucide-react";
import remarkGfm from "remark-gfm";
import "./styles.css";

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

const SESSION_PROVIDERS = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "doujie", label: "Doujie" },
];

const markdownComponents = {
  a(props) {
    const { children, href, node, ...rest } = props;
    void node;
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  pre(props) {
    const { children, node, ...rest } = props;
    void node;
    return (
      <pre className="markdown-pre" {...rest}>
        {children}
      </pre>
    );
  },
  table(props) {
    const { children, node, ...rest } = props;
    void node;
    return (
      <div className="markdown-table-wrap">
        <table {...rest}>{children}</table>
      </div>
    );
  },
};

function App() {
  const [provider, setProvider] = useState("codex");
  const [index, setIndex] = useState(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [searchedSessions, setSearchedSessions] = useState([]);
  const [sessionSearchLoading, setSessionSearchLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isLive, setIsLive] = useState(true);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const providerRef = useRef(provider);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedSessionRef = useRef(selectedSession);
  const projectRequestRef = useRef(0);
  const sessionsRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const sessionSearchRequestRef = useRef(0);
  const liveRefreshTimerRef = useRef(null);
  const liveRefreshRunningRef = useRef(false);
  const liveRefreshPendingRef = useRef(false);
  const providerLabel =
    SESSION_PROVIDERS.find((item) => item.id === provider)?.label || provider;

  useEffect(() => {
    document.title = `${providerLabel} Session Browser`;
  }, [providerLabel]);

  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  const loadProjects = useCallback(async (force = false, quiet = false) => {
    const requestProvider = provider;
    const requestId = ++projectRequestRef.current;
    if (!quiet) {
      setLoading(true);
      setError("");
    }
    try {
      const data = await fetchJson(
        apiPath(
          force
            ? `/api/providers/${provider}/rescan`
            : `/api/providers/${provider}/projects`,
        ),
      );
      if (
        requestId !== projectRequestRef.current ||
        providerRef.current !== requestProvider
      ) {
        return;
      }
      setIndex(data);
      setSelectedProjectId((current) => {
        const nextProjectId = data.projects?.some((project) => project.id === current)
          ? current
          : data.projects?.[0]?.id || "";
        selectedProjectIdRef.current = nextProjectId;
        return nextProjectId;
      });
    } catch (err) {
      if (
        requestId === projectRequestRef.current &&
        providerRef.current === requestProvider
      ) {
        setError(err.message);
      }
    } finally {
      if (
        !quiet &&
        requestId === projectRequestRef.current &&
        providerRef.current === requestProvider
      ) {
        setLoading(false);
      }
    }
  }, [provider]);

  const loadProjectSessions = useCallback(
    async (projectId, quiet = false) => {
      if (!projectId) return;
      const requestProvider = provider;
      const requestId = ++sessionsRequestRef.current;
      if (!quiet) setError("");
      try {
        const data = await fetchJson(
          apiPath(`/api/providers/${provider}/projects/${projectId}/sessions`),
        );
        if (
          requestId !== sessionsRequestRef.current ||
          providerRef.current !== requestProvider ||
          selectedProjectIdRef.current !== projectId
        ) {
          return;
        }
        setSessions(data.sessions || []);
      } catch (err) {
        if (
          requestId === sessionsRequestRef.current &&
          providerRef.current === requestProvider
        ) {
          setError(err.message);
        }
      }
    },
    [provider],
  );

  const openSession = useCallback(
    async (sessionId) => {
      const requestProvider = provider;
      const requestId = ++sessionRequestRef.current;
      setError("");
      const data = await fetchJson(sessionDetailUrl(provider, sessionId));
      if (
        requestId !== sessionRequestRef.current ||
        providerRef.current !== requestProvider
      ) {
        return;
      }
      const nextProjectId = data.session?.projectId || "";
      if (nextProjectId && nextProjectId !== selectedProjectIdRef.current) {
        selectedProjectIdRef.current = nextProjectId;
        setProjectQuery("");
        setSelectedProjectId(nextProjectId);
      }
      selectedSessionRef.current = data.session;
      setSelectedSession(data.session);
    },
    [provider],
  );

  const loadFullSession = useCallback(async (sessionId) => {
    const currentProvider = providerRef.current;
    setError("");
    const data = await fetchJson(sessionDetailUrl(currentProvider, sessionId, true));
    if (providerRef.current !== currentProvider) {
      return;
    }
    setSelectedSession((current) => (current?.id === sessionId ? data.session : current));
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId) return;
    if (selectedSessionRef.current?.projectId !== selectedProjectId) {
      selectedSessionRef.current = null;
      setSelectedSession(null);
    }
    loadProjectSessions(selectedProjectId);
  }, [loadProjectSessions, selectedProjectId]);

  useEffect(() => {
    const query = sessionQuery.trim();
    const requestProvider = provider;
    const requestId = ++sessionSearchRequestRef.current;

    if (!query) {
      setSearchedSessions([]);
      setSessionSearchLoading(false);
      return undefined;
    }

    setSessionSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await fetchJson(
          apiPath(
            `/api/providers/${requestProvider}/sessions/search?q=${encodeURIComponent(query)}&limit=80`,
          ),
        );
        if (
          requestId !== sessionSearchRequestRef.current ||
          providerRef.current !== requestProvider
        ) {
          return;
        }
        setSearchedSessions(data.sessions || []);
      } catch (err) {
        if (
          requestId === sessionSearchRequestRef.current &&
          providerRef.current === requestProvider
        ) {
          setError(err.message);
          setSearchedSessions([]);
        }
      } finally {
        if (
          requestId === sessionSearchRequestRef.current &&
          providerRef.current === requestProvider
        ) {
          setSessionSearchLoading(false);
        }
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [provider, sessionQuery]);

  const refreshLive = useCallback(() => {
    liveRefreshPendingRef.current = true;
    if (liveRefreshTimerRef.current) clearTimeout(liveRefreshTimerRef.current);

    liveRefreshTimerRef.current = setTimeout(async () => {
      if (liveRefreshRunningRef.current) return;
      liveRefreshRunningRef.current = true;

      try {
        while (liveRefreshPendingRef.current) {
          liveRefreshPendingRef.current = false;
          const currentProvider = providerRef.current;
          const currentProjectId = selectedProjectIdRef.current;
          const currentSession = selectedSessionRef.current;

          await loadProjects(false, true);
          if (providerRef.current !== currentProvider) continue;
          if (currentProjectId) {
            await loadProjectSessions(currentProjectId, true);
          }
          if (
            providerRef.current === currentProvider &&
            currentSession?.id &&
            !currentSession.isVirtual
          ) {
            const requestId = ++sessionRequestRef.current;
            try {
              const data = await fetchJson(
                sessionDetailUrl(
                  currentProvider,
                  currentSession.id,
                  currentSession.hiddenEventsOmitted === false,
                ),
              );
              if (
                requestId !== sessionRequestRef.current ||
                providerRef.current !== currentProvider
              ) {
                continue;
              }
              setSelectedSession((current) =>
                mergeLiveSessionDetail(current, currentSession.id, data.session),
              );
            } catch (err) {
              if (
                requestId === sessionRequestRef.current &&
                providerRef.current === currentProvider
              ) {
                setError(err.message);
              }
            }
          }
        }
      } finally {
        liveRefreshRunningRef.current = false;
      }
    }, 250);
  }, [loadProjectSessions, loadProjects]);

  useEffect(() => {
    if (!isLive) return undefined;

    let fallbackTimer = null;
    const source = new EventSource(apiPath(`/api/events?provider=${provider}`));
    const startFallback = () => {
      if (!fallbackTimer) fallbackTimer = setInterval(refreshLive, 5_000);
    };

    source.addEventListener("change", refreshLive);
    source.addEventListener("ready", (event) => {
      const payload = parseEventData(event.data);
      const hasWatcherFailure = payload?.watchers?.some((watcher) => !watcher.ok);
      if (hasWatcherFailure) startFallback();
    });
    source.addEventListener("watcher-status", (event) => {
      const payload = parseEventData(event.data);
      const hasWatcherFailure = payload?.watchers?.some((watcher) => !watcher.ok);
      if (hasWatcherFailure) startFallback();
    });
    source.addEventListener("open", () => {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    });
    source.addEventListener("error", startFallback);

    return () => {
      source.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
      if (liveRefreshTimerRef.current) {
        clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
      liveRefreshPendingRef.current = false;
    };
  }, [isLive, provider, refreshLive]);

  const rescan = useCallback(async () => {
    await loadProjects(true);
    if (selectedProjectId) await loadProjectSessions(selectedProjectId, true);
  }, [loadProjectSessions, loadProjects, selectedProjectId]);

  const selectProject = useCallback((projectId) => {
    sessionSearchRequestRef.current += 1;
    selectedProjectIdRef.current = projectId;
    setSessionQuery("");
    setSearchedSessions([]);
    setSessionSearchLoading(false);
    setSelectedProjectId(projectId);
    setShowWorkspace(false);
  }, []);

  const selectProvider = useCallback(
    (nextProvider) => {
      if (nextProvider === provider) return;
      providerRef.current = nextProvider;
      projectRequestRef.current += 1;
      sessionsRequestRef.current += 1;
      sessionRequestRef.current += 1;
      sessionSearchRequestRef.current += 1;
      if (liveRefreshTimerRef.current) {
        clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
      liveRefreshPendingRef.current = false;
      setProvider(nextProvider);
      setIndex(null);
      setSessions([]);
      selectedProjectIdRef.current = "";
      selectedSessionRef.current = null;
      setSelectedProjectId("");
      setSelectedSession(null);
      setProjectQuery("");
      setSessionQuery("");
      setSearchedSessions([]);
      setSessionSearchLoading(false);
      setLoading(true);
      setError("");
    },
    [provider],
  );

  const projects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return index?.projects || [];
    return (index?.projects || []).filter((project) =>
      [project.name, project.path].join(" ").toLowerCase().includes(query),
    );
  }, [index, projectQuery]);

  const visibleSessions = sessionQuery.trim() ? searchedSessions : sessions;

  const selectedProject = (index?.projects || []).find(
    (project) => project.id === selectedProjectId,
  );
  return (
    <main className="app-shell">
      <WorkspacePanel
        className="sidebar"
        index={index}
        isLive={isLive}
        onClose={() => setShowWorkspace(false)}
        onProjectSelect={selectProject}
        onRescan={rescan}
        onToggleLive={() => setIsLive((current) => !current)}
        projectQuery={projectQuery}
        projects={projects}
        provider={provider}
        providerLabel={providerLabel}
        selectedProjectId={selectedProjectId}
        selectProvider={selectProvider}
        setProjectQuery={setProjectQuery}
      />

      {showWorkspace ? (
        <div className="workspace-overlay" onClick={() => setShowWorkspace(false)}>
          <WorkspacePanel
            className="workspace-drawer"
            index={index}
            isLive={isLive}
            onClose={() => setShowWorkspace(false)}
            onProjectSelect={selectProject}
            onRescan={rescan}
            onToggleLive={() => setIsLive((current) => !current)}
            projectQuery={projectQuery}
            projects={projects}
            provider={provider}
            providerLabel={providerLabel}
            selectedProjectId={selectedProjectId}
            selectProvider={selectProvider}
            setProjectQuery={setProjectQuery}
          />
        </div>
      ) : null}

      <section className="content">
        <header className={`mobile-banner ${selectedSession ? "is-detail" : ""}`}>
          <button
            className="icon-button"
            aria-label={selectedSession ? "Back to sessions" : "Open workspace"}
            onClick={selectedSession ? () => setSelectedSession(null) : () => setShowWorkspace(true)}
            title={selectedSession ? "Back to sessions" : "Open workspace"}
          >
            {selectedSession ? <ChevronLeft size={18} /> : <Menu size={18} />}
          </button>
          <div>
            <strong title={selectedSession?.title || selectedProject?.name || providerLabel}>
              {selectedSession?.title || selectedProject?.name || providerLabel}
            </strong>
            <span title={selectedSession?.cwd || selectedSession?.projectPath || ""}>
              {selectedSession
                ? `${providerLabel} · ${selectedSession.projectPath || selectedSession.cwd || "Session"}`
                : `${providerLabel} Sessions`}
            </span>
          </div>
          {selectedSession ? (
            <button
              className="icon-button"
              aria-label="Open workspace"
              onClick={() => setShowWorkspace(true)}
              title="Open workspace"
            >
              <Menu size={18} />
            </button>
          ) : null}
        </header>
        {error && <div className="error-banner">{error}</div>}
        {loading && !index ? (
          <div className="empty-state">Scanning {providerLabel} session files...</div>
        ) : selectedSession ? (
          <SessionDetail
            key={selectedSession.id}
            session={selectedSession}
            onOpenSession={openSession}
            onLoadFullSession={loadFullSession}
            onBack={() => setSelectedSession(null)}
          />
        ) : (
          <SessionList
            project={selectedProject}
            sessions={visibleSessions}
            query={sessionQuery}
            searching={sessionSearchLoading}
            setQuery={setSessionQuery}
            onOpenSession={openSession}
            providerLabel={providerLabel}
          />
        )}
      </section>
    </main>
  );
}

function WorkspacePanel({
  className,
  index,
  isLive,
  onClose,
  onProjectSelect,
  onRescan,
  onToggleLive,
  projectQuery,
  projects,
  provider,
  providerLabel,
  selectedProjectId,
  selectProvider,
  setProjectQuery,
}) {
  const projectListRef = useRef(null);

  useEffect(() => {
    if (!selectedProjectId) return;
    const selectedRow = projectListRef.current?.querySelector(
      `[data-project-id="${cssEscape(selectedProjectId)}"]`,
    );
    selectedRow?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [projects, selectedProjectId]);

  return (
    <aside className={className} onClick={(event) => event.stopPropagation()}>
      <div className="brand">
        <div>
          <h1>{providerLabel} Sessions</h1>
          <p>
            {index
              ? `${index.mainSessionCount} main · ${index.subagentSessionCount} subagents`
              : "Loading"}
          </p>
        </div>
        <div className="brand-actions">
          <button className={`live-button ${isLive ? "is-active" : ""}`} onClick={onToggleLive}>
            {isLive ? "Live on" : "Live off"}
          </button>
          <button
            className="icon-button"
            aria-label={`Rescan ${providerLabel} sessions`}
            title={`Rescan ${providerLabel} sessions`}
            onClick={onRescan}
          >
            <RefreshCw size={18} />
          </button>
          <button
            className="icon-button drawer-close"
            aria-label="Close workspace"
            onClick={onClose}
            title="Close workspace"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="provider-switch" aria-label="Session source">
        {SESSION_PROVIDERS.map((item) => (
          <button
            className={provider === item.id ? "is-selected" : ""}
            key={item.id}
            onClick={() => selectProvider(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <label className="search-box">
        <Search size={16} />
        <input
          value={projectQuery}
          onChange={(event) => setProjectQuery(event.target.value)}
          placeholder="Search projects"
        />
      </label>

      <div className="project-list" ref={projectListRef}>
        {projects.map((project) => (
          <button
            key={project.id}
            data-project-id={project.id}
            className={`project-row ${selectedProjectId === project.id ? "is-selected" : ""}`}
            onClick={() => onProjectSelect(project.id)}
          >
            <Folder size={17} />
            <span>
              <strong>{project.name}</strong>
              <small>
                {project.sessionCount} main
                {project.subagentSessionCount
                  ? ` · ${project.subagentSessionCount} subagents`
                  : ""}
              </small>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function SessionList({
  project,
  sessions,
  query,
  searching,
  setQuery,
  onOpenSession,
  providerLabel,
}) {
  if (!project) {
    return <div className="empty-state">No {providerLabel} projects found.</div>;
  }

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">{project.path}</p>
          <h2>{project.name}</h2>
        </div>
        <div className="stats">
          <Stat label="Messages" value={project.messageCount} />
          <Stat label="Tools" value={project.toolCallCount} />
          <Stat label="Subagents" value={project.subagentSessionCount} />
          <Stat label="Parse errors" value={project.parseErrorCount} />
        </div>
      </header>

      <div className="search-box session-search">
        <Search size={16} />
        <input
          aria-label="Search sessions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions by id, title, path"
        />
        {query ? (
          <button
            className="search-clear-button"
            type="button"
            aria-label="Clear session search"
            title="Clear session search"
            onClick={() => setQuery("")}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {query ? (
        <p className="session-search-hint">
          {searching ? "Searching all sessions..." : `${sessions.length} session matches`}
        </p>
      ) : null}

      <div className="session-grid">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
    </>
  );
}

function SessionRow({ session, onOpenSession, child = false }) {
  const identity = sessionSearchIdentity(session);
  return (
    <div className={`session-group ${child ? "is-child" : ""}`}>
      <button
        className={`session-row ${child ? "child-session-row" : ""} ${
          session.isVirtual ? "virtual-session-row" : ""
        }`}
        disabled={session.isVirtual}
        onClick={() => {
          if (!session.isVirtual) onOpenSession(session.id);
        }}
      >
        <span className="session-main">
          <span className="session-title">
            {session.isSidechain && <span className="pill">sidechain</span>}
            {(child || session.isSubagent) && <span className="pill">subagent</span>}
            {session.isVirtual && <span className="pill">parent</span>}
            <span className="session-title-text">{session.title}</span>
          </span>
          <span className="session-summary">
            {session.firstUserText || session.relativePath}
          </span>
          <span className="session-meta">
            <Clock size={14} />
            <span>
              {formatDate(session.lastTimestamp || session.firstTimestamp)}
              {session.gitBranch ? ` · ${session.gitBranch}` : ""}
              {session.agentName ? ` · ${session.agentName}` : ""}
            </span>
            {identity ? <span className="session-id">· id {identity}</span> : null}
          </span>
        </span>
        <span className="session-counts">
          <b>{session.messageCount}</b> msg
          <b>{session.toolCallCount}</b> tools
          {session.childSessionCount ? (
            <>
              <b>{session.childSessionCount}</b> sub
            </>
          ) : null}
        </span>
      </button>
      {session.childSessions?.length ? (
        <div className="child-session-list">
          {session.childSessions.map((childSession) => (
            <SessionRow
              child
              key={childSession.id}
              session={childSession}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SessionDetail({
  session,
  onOpenSession,
  onLoadFullSession,
  onBack,
}) {
  const timelineRef = useRef(null);
  const initialBottomSessionRef = useRef("");
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [showSystemEvents, setShowSystemEvents] = useState(false);
  const [showToolEvents, setShowToolEvents] = useState(false);
  const [showSubagentMenu, setShowSubagentMenu] = useState(false);
  const [showSessionInfo, setShowSessionInfo] = useState(false);
  const [loadingHiddenEvents, setLoadingHiddenEvents] = useState(false);
  const systemEventCount =
    session.hiddenEventsOmitted && !showSystemEvents
      ? session.omittedSystemEventCount || 0
      : session.events.filter(isSystemEvent).length;
  const toolEventCount =
    session.hiddenEventsOmitted && !showToolEvents
      ? session.omittedToolEventCount || 0
      : session.events.filter(isToolEvent).length;
  const visibleEvents = session.events
    .map((event) =>
      filterTimelineEvent(event, {
        showSystemEvents,
        showToolEvents,
      }),
    )
    .filter(Boolean);
  const userNavEvents = useMemo(
    () => visibleEvents.filter(isNavigableUserEvent),
    [visibleEvents],
  );
  const userNavIndexById = useMemo(
    () => new Map(userNavEvents.map((event, index) => [event.id, index])),
    [userNavEvents],
  );
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  const showHiddenEvents = async (setter) => {
    if (session.hiddenEventsOmitted) {
      setLoadingHiddenEvents(true);
      try {
        await onLoadFullSession(session.id);
      } finally {
        setLoadingHiddenEvents(false);
      }
    }
    setter(true);
  };
  const scrollToTimelineBottom = () => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({
      top: timeline.scrollHeight,
      behavior: "smooth",
    });
    setCurrentMessageIndex(Math.max(0, userNavEvents.length - 1));
  };
  const scrollToTimelineTop = () => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({
      top: 0,
      behavior: "smooth",
    });
    setCurrentMessageIndex(0);
  };
  const scrollToMessageIndex = (index) => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const boundedIndex = Math.max(0, Math.min(index, userNavEvents.length - 1));
    const target = timeline.querySelector(`[data-message-nav-index="${boundedIndex}"]`);
    if (!target) return;
    setCurrentMessageIndex(boundedIndex);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const scrollByMessageOffset = (offset) => {
    const timeline = timelineRef.current;
    const focusedIndex = timeline
      ? getCurrentMessageIndexFromViewport(timeline)
      : currentMessageIndex;
    scrollToMessageIndex((focusedIndex ?? currentMessageIndex) + offset);
  };

  useEffect(() => {
    setCurrentMessageIndex((current) =>
      Math.max(0, Math.min(current, Math.max(0, userNavEvents.length - 1))),
    );
  }, [userNavEvents.length]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return undefined;

    let frame = 0;
    const updateCurrentMessage = () => {
      frame = 0;
      const nextIndex = getCurrentMessageIndexFromViewport(timeline);
      if (nextIndex !== null) setCurrentMessageIndex(nextIndex);
    };
    const handleScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(updateCurrentMessage);
    };

    updateCurrentMessage();
    timeline.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      timeline.removeEventListener("scroll", handleScroll);
    };
  }, [userNavEvents.length, visibleEvents.length]);

  useEffect(() => {
    if (initialBottomSessionRef.current === session.id) return undefined;
    initialBottomSessionRef.current = session.id;

    const timeline = timelineRef.current;
    if (!timeline) return undefined;

    let cancelled = false;
    let frame = 0;
    let nestedFrame = 0;

    const scrollToInitialBottom = () => {
      if (cancelled) return;
      timeline.scrollTop = timeline.scrollHeight;
      setCurrentMessageIndex(Math.max(0, userNavEvents.length - 1));
    };

    frame = requestAnimationFrame(() => {
      nestedFrame = requestAnimationFrame(scrollToInitialBottom);
    });

    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      if (nestedFrame) cancelAnimationFrame(nestedFrame);
    };
  }, [session.id, userNavEvents.length]);

  return (
    <>
      <header className="detail-header">
        <button className="back-button" onClick={onBack}>
          <ChevronLeft size={17} />
          Back
        </button>
        <div className="detail-title">
          <h2>{session.title}</h2>
          <p className="detail-project-path" title={session.projectPath || session.cwd || ""}>
            {session.projectPath || session.cwd || "Unknown project"}
          </p>
        </div>
      </header>

      <div className="detail-actions">
        <div className="action-group message-nav-buttons" aria-label="Message navigation">
          <button
            className="toggle-button jump-top-button"
            onClick={scrollToTimelineTop}
            title="Jump to top"
            aria-label="Jump to top"
          >
            <ArrowUpToLine size={14} />
            <span className="button-label">Top</span>
          </button>
          <button
            className="toggle-button"
            disabled={currentMessageIndex <= 0 || !userNavEvents.length}
            onClick={() => scrollByMessageOffset(-1)}
            title="Previous user input"
            aria-label="Previous user input"
          >
            <ChevronLeft size={14} />
            <span className="button-label">Previous</span>
          </button>
          <button
            className="toggle-button"
            disabled={
              !userNavEvents.length || currentMessageIndex >= userNavEvents.length - 1
            }
            onClick={() => scrollByMessageOffset(1)}
            title="Next user input"
            aria-label="Next user input"
          >
            <span className="button-label">Next</span>
            <ChevronRight size={14} />
          </button>
          <button
            className="toggle-button jump-bottom-button"
            onClick={scrollToTimelineBottom}
            title="Jump to bottom"
            aria-label="Jump to bottom"
          >
            <ArrowDownToLine size={14} />
            <span className="button-label">Bottom</span>
          </button>
        </div>
        <div className="action-group display-option-buttons" aria-label="Display options">
          <button
            className={`toggle-button ${renderMarkdown ? "is-active" : ""}`}
            title={renderMarkdown ? "Markdown rendering on" : "Plain text rendering"}
            aria-label={renderMarkdown ? "Markdown rendering on" : "Plain text rendering"}
            aria-pressed={renderMarkdown}
            onClick={() => setRenderMarkdown((current) => !current)}
          >
            <Braces size={14} />
            <span className="button-label">{renderMarkdown ? "Markdown on" : "Plain text"}</span>
          </button>
          <button
            className={`toggle-button ${showToolEvents ? "is-active" : ""}`}
            title={`${showToolEvents ? "Hide" : "Show"} tool events${toolEventCount ? ` (${toolEventCount})` : ""}`}
            aria-label={`${showToolEvents ? "Hide" : "Show"} tool events${toolEventCount ? ` (${toolEventCount})` : ""}`}
            aria-pressed={showToolEvents}
            disabled={loadingHiddenEvents}
            onClick={() => {
              if (showToolEvents) {
                setShowToolEvents(false);
                return;
              }
              void showHiddenEvents(setShowToolEvents);
            }}
          >
            <Hammer size={14} />
            <span className="button-label">
              {loadingHiddenEvents && !showToolEvents ? "Loading tools" : "Tools"}
            </span>
            {toolEventCount ? <span className="button-count">{toolEventCount}</span> : null}
          </button>
          <button
            className={`toggle-button ${showSystemEvents ? "is-active" : ""}`}
            title={`${showSystemEvents ? "Hide" : "Show"} system events${systemEventCount ? ` (${systemEventCount})` : ""}`}
            aria-label={`${showSystemEvents ? "Hide" : "Show"} system events${systemEventCount ? ` (${systemEventCount})` : ""}`}
            aria-pressed={showSystemEvents}
            disabled={loadingHiddenEvents}
            onClick={() => {
              if (showSystemEvents) {
                setShowSystemEvents(false);
                return;
              }
              void showHiddenEvents(setShowSystemEvents);
            }}
          >
            <Terminal size={14} />
            <span className="button-label">
              {loadingHiddenEvents && !showSystemEvents ? "Loading system" : "System"}
            </span>
            {systemEventCount ? <span className="button-count">{systemEventCount}</span> : null}
          </button>
          <SessionInfoMenu
            open={showSessionInfo}
            onClose={() => setShowSessionInfo(false)}
            onToggle={() => setShowSessionInfo((current) => !current)}
            session={session}
          />
        </div>
        {session.parentSessionRowId ? (
          <div className="action-group parent-action-group">
            <button
              className="toggle-button parent-session-button"
              onClick={() => onOpenSession(session.parentSessionRowId)}
              title={`Open parent agent${session.parentSessionTitle ? `: ${session.parentSessionTitle}` : ""}`}
              aria-label="Open parent agent"
            >
              <ChevronLeft size={14} />
              <span className="button-label">Parent</span>
            </button>
          </div>
        ) : null}
        {session.childSessions?.length ? (
          <div className="action-group subagent-action-group">
            <SubagentMenu
              open={showSubagentMenu}
              sessions={session.childSessions}
              onToggle={() => setShowSubagentMenu((current) => !current)}
              onClose={() => setShowSubagentMenu(false)}
              onOpenSession={(sessionId) => {
                setShowSubagentMenu(false);
                onOpenSession(sessionId);
              }}
            />
          </div>
        ) : null}
      </div>

      <div className="timeline" ref={timelineRef}>
        {visibleEvents.map((event) => (
          <TimelineEvent
            event={event}
            key={event.id}
            messageNavIndex={userNavIndexById.get(event.id) ?? -1}
            renderMarkdown={renderMarkdown}
          />
        ))}
      </div>
    </>
  );
}

function SessionInfoMenu({ open, onClose, onToggle, session }) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  return (
    <div className="session-info-menu">
      <button
        className={`toggle-button session-info-button ${open ? "is-active" : ""}`}
        onClick={onToggle}
        title="Session info"
        aria-label="Session info"
        aria-expanded={open}
      >
        <Info size={14} />
        <span className="button-label">Info</span>
      </button>
      {open ? (
        <>
          <div
            className="session-info-backdrop"
            onClick={onClose}
            aria-hidden="true"
          />
          <div
            className="session-info-popover"
            role="dialog"
            aria-label="Session info"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="session-info-head">
              <strong>{session.title}</strong>
              <button
                className="icon-button"
                aria-label="Close session info"
                title="Close session info"
                onClick={onClose}
              >
                <X size={15} />
              </button>
            </div>
            <dl className="session-info-list">
              <div>
                <dt>Time</dt>
                <dd>
                  {formatDate(session.firstTimestamp)} to {formatDate(session.lastTimestamp)}
                </dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>{session.projectPath || "Unknown project"}</dd>
              </div>
              <div>
                <dt>CWD</dt>
                <dd>{session.cwd || "Unknown cwd"}</dd>
              </div>
              <div className="session-info-stats">
                <Stat label="Messages" value={session.messageCount} />
                <Stat label="Tools" value={session.toolCallCount} />
                <Stat label="Results" value={session.toolResultCount} />
              </div>
            </dl>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SubagentMenu({ open, sessions, onToggle, onClose, onOpenSession }) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  return (
    <div className="subagent-menu">
      <button
        className={`toggle-button ${open ? "is-active" : ""}`}
        onClick={onToggle}
        title={`Subagents (${sessions.length})`}
        aria-label={`Subagents (${sessions.length})`}
        aria-expanded={open}
      >
        <Users size={14} />
        <span className="button-label">Subagents</span>
        <span className="button-count">{sessions.length}</span>
      </button>
      {open ? (
        <>
          <div
            className="subagent-backdrop"
            onClick={onClose}
            aria-hidden="true"
          />
          <div
            className="subagent-popover"
            role="dialog"
            aria-label="Subagents"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="subagent-menu-head">
              <strong>Subagents</strong>
              <span>{sessions.length}</span>
            </div>
            <div className="subagent-menu-list">
              {sessions.map((childSession) => (
                <button
                  className="subagent-menu-row"
                  key={childSession.id}
                  onClick={() => onOpenSession(childSession.id)}
                >
                  <span>
                    <b>{childSession.agentName || childSession.title}</b>
                    <small>{childSession.firstUserText || childSession.relativePath}</small>
                  </span>
                  <small>
                    {formatDate(childSession.lastTimestamp || childSession.firstTimestamp)}
                  </small>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function TimelineEvent({ event, messageNavIndex = -1, renderMarkdown }) {
  if (event.kind === "metadata") {
    return (
      <article className="timeline-item metadata">
        <Braces size={16} />
        <span>
          {event.label}: <b>{event.value}</b>
        </span>
      </article>
    );
  }

  if (event.kind === "attachment") {
    return (
      <article className="timeline-item system">
        <Terminal size={16} />
        <div>
          <div className="message-head">
            <strong>{event.title}</strong>
            <time>{formatDate(event.timestamp)}</time>
          </div>
          <details className="foldout">
            <summary>Attachment payload</summary>
            <JsonBlock value={event.attachment} />
          </details>
        </div>
      </article>
    );
  }

  if (event.kind === "tool_result") {
    const result = event.segments.find((segment) => segment.kind === "tool_result");
    return (
      <article className="timeline-item tool compact-event">
        <Terminal size={18} />
        <details className="event-foldout">
          <summary>
            <span>
              <strong>{result?.isError ? "Tool error" : "Tool result"}</strong>
              {result?.toolUseId && <code>{result.toolUseId}</code>}
            </span>
            <time>{formatDate(event.timestamp)}</time>
          </summary>
          {event.segments.map((segment) => (
            <ToolResultBody segment={segment} key={`${event.id}:${segment.index}`} />
          ))}
        </details>
      </article>
    );
  }

  if (event.kind !== "message") {
    return (
      <article className="timeline-item system">
        <Braces size={16} />
        <JsonBlock value={event.raw || event} />
      </article>
    );
  }

  const Icon = event.role === "assistant" ? Bot : User;
  const hasText = event.segments.some((segment) => segment.kind === "text");
  const isAssistantAction = event.role === "assistant" && !hasText;
  return (
    <article
      className={`timeline-item ${event.role} ${
        isAssistantAction ? "assistant-action" : ""
      }`}
      data-message-nav-index={messageNavIndex >= 0 ? messageNavIndex : undefined}
    >
      <Icon size={18} />
      <div className="message-body">
        <div className="message-head">
          <strong>
            {event.role === "assistant"
              ? isAssistantAction
                ? "Assistant action"
                : "Assistant"
              : "User"}
            {event.isMeta ? " meta" : ""}
          </strong>
          <time>{formatDate(event.timestamp)}</time>
        </div>
        {event.segments.map((segment) => (
          <Segment
            segment={segment}
            key={`${event.id}:${segment.index}`}
            renderMarkdown={renderMarkdown && event.role === "assistant"}
          />
        ))}
      </div>
    </article>
  );
}

function sessionSearchIdentity(session) {
  return (
    session.codexThreadId ||
    session.sessionId ||
    session.fileSessionId ||
    session.id ||
    ""
  );
}

function isSystemEvent(event) {
  return (
    event.isMetaArtifact ||
    event.kind === "metadata" ||
    event.kind === "attachment" ||
    event.kind === "raw" ||
    event.kind === "parse_error"
  );
}

function isToolEvent(event) {
  return (
    event.kind === "tool_result" ||
    (event.role === "assistant" &&
      event.kind === "message" &&
      !event.segments.some((segment) => segment.kind === "text"))
  );
}

function isNavigableUserEvent(event) {
  return (
    event.kind === "message" &&
    event.role === "user" &&
    event.segments?.some((segment) => segment.kind === "text" && segment.text?.trim())
  );
}

function getCurrentMessageIndexFromViewport(timeline) {
  const items = [...timeline.querySelectorAll("[data-message-nav-index]")];
  if (!items.length) return null;

  const timelineRect = timeline.getBoundingClientRect();
  const topEdge = timelineRect.top + 12;
  const bottomEdge = timelineRect.bottom - 12;
  const focusLine = topEdge + (bottomEdge - topEdge) * 0.38;
  let best = null;

  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const visibleTop = Math.max(rect.top, topEdge);
    const visibleBottom = Math.min(rect.bottom, bottomEdge);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    if (!visibleHeight) continue;

    const visibleRatio = visibleHeight / Math.max(1, rect.height);
    const midpoint = visibleTop + visibleHeight / 2;
    const distance = Math.abs(midpoint - focusLine);
    const score = visibleRatio * 1000 - distance;
    if (!best || score > best.score) {
      best = {
        index: Number(item.dataset.messageNavIndex || 0),
        score,
      };
    }
  }

  if (best) return best.index;

  let nearest = null;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const edgeDistance =
      focusLine < rect.top
        ? rect.top - focusLine
        : focusLine > rect.bottom
          ? focusLine - rect.bottom
          : 0;
    const distance = edgeDistance || Math.abs(midpoint - focusLine);
    if (!nearest || distance < nearest.distance) {
      nearest = {
        index: Number(item.dataset.messageNavIndex || 0),
        distance,
      };
    }
  }

  return nearest?.index ?? Number(items[0].dataset.messageNavIndex || 0);
}

function filterTimelineEvent(event, options) {
  if (!options.showSystemEvents && isSystemEvent(event)) return null;
  if (!options.showToolEvents && isToolEvent(event)) return null;
  if (!Array.isArray(event.segments)) return event;

  const segments = event.segments.filter((segment) => {
    if (!options.showToolEvents && isToolSegment(segment)) return false;
    if (!options.showSystemEvents && isSystemSegment(segment)) return false;
    return true;
  });
  if (!segments.length) return null;
  if (segments.length === event.segments.length) return event;
  return { ...event, segments };
}

function isToolSegment(segment) {
  return segment.kind === "tool_call" || segment.kind === "tool_result";
}

function isSystemSegment(segment) {
  return segment.kind === "thinking";
}

function Segment({ segment, renderMarkdown = false }) {
  if (segment.kind === "text") {
    if (renderMarkdown) {
      return <MarkdownBlock value={segment.text} />;
    }
    return <TextBlock value={segment.text} />;
  }

  if (segment.kind === "thinking") {
    return (
      <details className="foldout compact-foldout">
        <summary>Thinking</summary>
        <TextBlock value={segment.text} />
      </details>
    );
  }

  if (segment.kind === "tool_call") {
    return (
      <details className="tool-block compact-tool">
        <summary className="tool-title">
          <Hammer size={15} />
          <strong>{segment.name}</strong>
          {segment.id && <code>{segment.id}</code>}
        </summary>
        <JsonBlock value={segment.input} />
      </details>
    );
  }

  if (segment.kind === "tool_result") {
    return (
      <ToolResultSegment segment={segment} />
    );
  }

  return <JsonBlock value={segment} />;
}

function ToolResultSegment({ segment }) {
  return (
    <details
      className={`tool-block result compact-tool ${segment.isError ? "is-error" : ""}`}
    >
      <summary className="tool-title">
        <Terminal size={15} />
        <strong>{segment.isError ? "Tool error" : "Tool result"}</strong>
        {segment.toolUseId && <code>{segment.toolUseId}</code>}
      </summary>
      <TextBlock value={formatSegmentContent(segment.content)} />
    </details>
  );
}

function ToolResultBody({ segment }) {
  if (segment.kind !== "tool_result") return <Segment segment={segment} />;
  return (
    <div className={`tool-result-body ${segment.isError ? "is-error" : ""}`}>
      <TextBlock value={formatSegmentContent(segment.content)} />
    </div>
  );
}

function MarkdownBlock({ value }) {
  const text = String(value ?? "");
  const previewLimit = 8_000;
  const content =
    text.length > previewLimit
      ? `${text.slice(0, previewLimit).trimEnd()}\n\n...`
      : text;

  return (
    <div>
      <div className="markdown-block">
        <Markdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
          {content}
        </Markdown>
      </div>
      {text.length > previewLimit ? (
        <details className="foldout">
          <summary>{text.length.toLocaleString()} characters total</summary>
          <div className="markdown-block expanded-markdown">
            <Markdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
              {text}
            </Markdown>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function JsonBlock({ value }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length > 1_200) {
    return (
      <details className="foldout">
        <summary>{text.length.toLocaleString()} characters</summary>
        <pre className="json-block">{text}</pre>
      </details>
    );
  }

  return (
    <pre className="json-block">
      {text}
    </pre>
  );
}

function TextBlock({ value }) {
  const text = String(value ?? "");
  if (text.length <= 1_400) {
    return <pre className="text-block">{text}</pre>;
  }

  return (
    <div>
      <pre className="text-block">{`${text.slice(0, 1_400).trimEnd()}\n...`}</pre>
      <details className="foldout">
        <summary>{text.length.toLocaleString()} characters total</summary>
        <pre className="text-block">{text}</pre>
      </details>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <span className="stat">
      <b>{value ?? 0}</b>
      <small>{label}</small>
    </span>
  );
}

function formatSegmentContent(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

function formatDate(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed: ${url}`);
  return data;
}

function apiPath(path) {
  return `${BASE_PATH}${path}`;
}

function sessionDetailUrl(provider, sessionId, includeHiddenEvents = false) {
  const params = includeHiddenEvents ? "?includeHiddenEvents=1" : "";
  return apiPath(`/api/providers/${provider}/sessions/${sessionId}${params}`);
}

function mergeLiveSessionDetail(current, sessionId, nextSession) {
  if (current?.id !== sessionId) return current;
  if (current.hiddenEventsOmitted === false && nextSession.hiddenEventsOmitted) {
    return current;
  }
  return nextSession;
}

function parseEventData(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const container = document.getElementById("root");
const root =
  globalThis.__claudeSessionBrowserRoot ||
  createRoot(container);

globalThis.__claudeSessionBrowserRoot = root;
root.render(<App />);
