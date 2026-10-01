import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  AudioLines,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  Eye,
  EyeOff,
  FileText,
  Globe2,
  Headphones,
  KeyRound,
  LoaderCircle,
  LogOut,
  MessageSquare,
  Mic,
  Play,
  Radio,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import {
  configSchema,
  defaultPrompt,
  secretFields,
  type Config,
  type PublicConfig,
  type SecretField,
} from '../shared/config';
import { defaultEducationPrompt } from '../shared/education-prompt';
import { api, post } from './api';
import AudioLab from './AudioLab';

type Status = {
  state: string;
  error: string | null;
  bot: {
    id: number;
    username?: string;
    first_name: string;
    can_join_groups?: boolean;
    can_read_all_group_messages?: boolean;
  } | null;
  lastPoll: number | null;
};
type Snapshot = {
  config: PublicConfig;
  status: Status;
  readiness: { cloud: boolean; openai: boolean; asr: boolean };
};
type Audience = {
  chats: {
    id: string;
    title: string;
    type: string;
    language: string;
    enabled: boolean;
    memberCount: number | null;
    messageCount: number;
    audioCount: number;
    pdfCount: number;
    lastPdfAt: number | null;
    describeMedia: boolean;
    lastActive: number;
    dailyMessages?: Record<string, number>;
  }[];
  metrics: {
    groups: number;
    privateUsers: number;
    uniqueUsers: number;
    processed: number;
    succeeded: number;
    failed: number;
    summaries: number;
    pdfsGenerated: number;
    groupPdfs: number;
    privatePdfs: number;
    pdfTrackingStartedAt: number;
    successRate: number | null;
  };
};
type Log = { id: number; time: string; level: string; message: string };
type Summary = {
  text: string;
  provider: string;
  model: string;
  fallback: boolean;
  durationMs: number;
};
const titles = {
  bot: ['Telegram bot', 'A little less listening. A lot more understanding.'],
  audience: ['Audience & groups', 'Every conversation, connected in one place.'],
  audio: ['Audio playground', 'Turn a voice into something you can read.'],
} as const;
type Tab = keyof typeof titles;
function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className={`logo ${small ? 'small' : ''}`}>
      <AudioLines size={small ? 19 : 25} />
    </div>
  );
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Secret({
  label,
  value,
  saved,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  saved: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="secret-field">
      <Field label={label}>
        <div className="secret-input">
          <input
            autoComplete="off"
            spellCheck={false}
            type={visible ? 'text' : 'password'}
            value={value}
            placeholder={saved ? '••••••••••••  saved securely on server' : 'Paste your API key'}
            onChange={(e) => onChange(e.target.value)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`${visible ? 'Hide' : 'Show'} ${label}`}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
      </Field>
      {saved && (
        <button className="text-button clear-key" type="button" onClick={onClear}>
          Remove saved key
        </button>
      )}
    </div>
  );
}
function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`toggle ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <div className="login-decoration">
        <AudioLines size={300} strokeWidth={0.5} />
      </div>
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void post('/api/auth/login', { password })
            .then(onLogin)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <Logo />
        <p className="eyebrow mt-8">YOUR TELEGRAM WORKSPACE</p>
        <h1>Welcome to Voice Studio.</h1>
        <p className="login-copy">
          Less noise. More clarity.
          <br />
          Your conversations, beautifully understood.
        </p>
        <Field label="Dashboard password">
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Enter your admin password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary w-full mt-5" disabled={busy}>
          {busy ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowUpRight size={17} />}
          Open workspace
        </button>
        <p className="footnote">
          <ShieldCheck size={13} />
          Protected administration · configured with ADMIN_PASSWORD
        </p>
      </form>
    </div>
  );
}
export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    void api('/api/auth/session')
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
    const expired = () => setAuthenticated(false);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  if (authenticated === null)
    return (
      <div className="loading-screen">
        <Logo />
        <LoaderCircle className="animate-spin mt-5" />
      </div>
    );
  return authenticated ? (
    <Dashboard
      logout={() => {
        void post('/api/auth/logout').finally(() => setAuthenticated(false));
      }}
    />
  ) : (
    <Login onLogin={() => setAuthenticated(true)} />
  );
}
function Dashboard({ logout }: { logout: () => void }) {
  const [tab, setTab] = useState<Tab>('bot');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [config, setConfig] = useState<Config>(configSchema.parse({}));
  const [clearSecrets, setClearSecrets] = useState<SecretField[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [live, setLive] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [verified, setVerified] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [help, setHelp] = useState(false);
  const setFromSnapshot = (data: Snapshot) => {
    const { credentials: _credentials, ...values } = data.config;
    for (const key of secretFields) values[key] = '';
    setConfig(values);
    setClearSecrets([]);
    setDirty(false);
  };
  const refresh = useCallback(async () => {
    const [s, a] = await Promise.all([
      api<Snapshot>('/api/bot/config'),
      api<Audience>('/api/bot/audience'),
    ]);
    setSnapshot(s);
    setAudience(a);
    return s;
  }, []);
  useEffect(() => {
    void refresh()
      .then(setFromSnapshot)
      .catch((e) => setNotice({ text: e.message, error: true }));
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 7000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onopen = () => setLive(true);
    events.onerror = () => setLive(false);
    events.addEventListener('snapshot', (event) => setLogs(JSON.parse(event.data) as Log[]));
    events.addEventListener('log', (event) =>
      setLogs((values) => [...values, JSON.parse(event.data) as Log].slice(-200)),
    );
    return () => events.close();
  }, []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const change = <K extends keyof Config>(key: K, value: Config[K]) => {
    setConfig((c) => ({ ...c, [key]: value }));
    setDirty(true);
    if (key === 'chatGptApiKey') setVerified('');
    if (secretFields.includes(key as SecretField))
      setClearSecrets((v) => v.filter((k) => k !== key));
  };
  const clear = (key: SecretField) => {
    setConfig((c) => ({ ...c, [key]: '' }));
    setClearSecrets((v) => [...new Set([...v, key])]);
    setDirty(true);
    if (key === 'chatGptApiKey') setVerified('');
  };
  const saved = (key: SecretField) =>
    !!snapshot?.config.credentials[key] && !clearSecrets.includes(key);
  const draft = () => ({ ...config, clearSecrets });
  const action = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    } finally {
      setBusy('');
    }
  };
  const save = () =>
    action('save', async () => {
      const data = await post<Snapshot>('/api/bot/config', draft());
      setSnapshot(data);
      setFromSnapshot(data);
      setNotice({ text: 'Settings saved. Your bot is using the latest configuration.' });
    });
  const verify = () =>
    action('verify', async () => {
      const data = await post<{
        valid: boolean;
        latencyMs: number;
        models: string[];
        note: string;
      }>('/api/bot/verify-chatgpt', {
        apiKey: config.chatGptApiKey || undefined,
        baseUrl: config.chatGptBaseUrl,
      });
      setVerified(`Verified · ${data.latencyMs} ms`);
      setModels(data.models);
      setNotice({
        text: data.note + (dirty ? ' Save settings to connect this key to the bot.' : ''),
      });
    });
  const test = () =>
    action('summary', async () => {
      setSummary(null);
      setSummary(await post<Summary>('/api/bot/test-summary', { config: draft() }));
    });
  const updateChat = (id: string, patch: object) =>
    action(`chat-${id}`, async () => {
      await api(`/api/bot/audience/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await refresh();
    });
  const metrics = audience?.metrics;
  const active = snapshot?.status.state === 'polling';
  const choices = [
    ...new Set(['gpt-4o-mini', 'gpt-4o', 'chatgpt-4o-latest', config.chatGptModel, ...models]),
  ];
  const chats =
    audience?.chats.filter(
      (c) =>
        `${c.title} ${c.id}`.toLowerCase().includes(search.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'private' && c.type === 'private') ||
          (filter === 'groups' && c.type !== 'private') ||
          (filter === 'private-pdfs' && c.type === 'private' && c.pdfCount > 0) ||
          (filter === 'group-pdfs' && c.type !== 'private' && c.pdfCount > 0)),
    ) || [];
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setTab('bot');
          }}
        >
          <Logo />
          <div>
            Voice Studio<span>TELEGRAM WORKSPACE</span>
          </div>
        </a>
        <div className="workspace-chip">
          <span className="workspace-avatar">T</span>
          <div>
            TelegramBot<small>Personal workspace</small>
          </div>
          <ChevronRight size={15} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {(
            [
              { id: 'bot', icon: Bot, label: 'Telegram bot' },
              { id: 'audience', icon: Users, label: 'Audience & groups' },
              { id: 'audio', icon: AudioLines, label: 'Audio playground' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? 'selected' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={19} />
              {item.label}
              {item.id === 'bot' && <span className={`nav-dot ${active ? 'active' : ''}`} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="icon-box peach">
            <Sparkles size={19} />
          </span>
          <h3>Let conversations flow.</h3>
          <p>
            Your bot handles the listening.
            <br />
            You focus on what matters.
          </p>
          <button className="text-button" onClick={() => setHelp(true)}>
            Getting started <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            Setup guide
          </button>
          <button className="nav-item" onClick={logout}>
            <LogOut size={18} />
            Sign out
          </button>
          <div className="admin-profile">
            <div className="admin-avatar">A</div>
            <div>
              Administrator<small>Workspace owner</small>
            </div>
            <ShieldCheck size={17} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <span>{titles[tab][0]}</span>
          </div>
          <div className="topbar-right">
            <span className={`status-dot ${live ? 'green-dot' : ''}`} />
            {live ? 'Server connected' : 'Reconnecting…'}
            <span className="topbar-divider" />
            <button className="icon-button" aria-label="Sign out of workspace" onClick={logout}>
              <LogOut size={18} />
            </button>
            <button className="icon-button" aria-label="Setup guide" onClick={() => setHelp(true)}>
              <CircleHelp size={19} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <p className="eyebrow">A CLEARER KIND OF CONVERSATION</p>
              <h1>
                {titles[tab][0]}
                <span className="heading-dot">.</span>
              </h1>
              <p>{titles[tab][1]}</p>
            </div>
            {tab === 'bot' ? (
              <button
                className="button primary"
                disabled={!!busy || !snapshot}
                onClick={() => void save()}
              >
                {busy === 'save' ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <Save size={16} />
                )}
                Save changes{dirty && <i className="unsaved-dot" />}
              </button>
            ) : (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() =>
                  void action('refresh', async () => {
                    await refresh();
                  })
                }
              >
                <RefreshCw size={16} className={busy === 'refresh' ? 'animate-spin' : ''} />
                Refresh
              </button>
            )}
          </div>
          {notice && (
            <div
              role={notice.error ? 'alert' : 'status'}
              className={`notice ${notice.error ? 'error' : 'success'}`}
            >
              <span>{notice.text}</span>
              <button
                aria-label="Dismiss notification"
                className="icon-button"
                onClick={() => setNotice(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="metrics-grid">
            {[
              {
                label: 'Connected groups',
                value: metrics?.groups,
                icon: Users,
                color: 'blue',
                hint: 'Your shared conversations',
              },
              {
                label: 'Private users',
                value: metrics?.privateUsers,
                icon: MessageSquare,
                color: 'purple',
                hint: 'One-to-one connections',
              },
              {
                label: 'Audio processed',
                value: metrics?.processed,
                icon: Headphones,
                color: 'peach',
                hint: `${metrics?.summaries || 0} summaries generated`,
              },
              {
                label: 'PDFs generated',
                value: metrics?.pdfsGenerated,
                icon: FileText,
                color: 'purple',
                hint: `${metrics?.groupPdfs || 0} in groups · ${metrics?.privatePdfs || 0} in private chats`,
              },
              {
                label: 'Success rate',
                value: metrics?.successRate == null ? '—' : `${metrics.successRate}%`,
                icon: Activity,
                color: 'mint',
                hint: metrics?.processed
                  ? `${metrics.succeeded} successful transcriptions`
                  : 'Waiting for your first audio',
              },
            ].map((item) => (
              <section className="metric-card" key={item.label}>
                <div className="metric-label">
                  {item.label}
                  <span className={`metric-icon ${item.color}`}>
                    <item.icon size={17} />
                  </span>
                </div>
                <strong>{item.value ?? '—'}</strong>
                <p>{item.hint}</p>
              </section>
            ))}
          </div>
          {tab === 'bot' && (
            <>
              <div className="bot-profile">
                <div className="bot-profile-icon">
                  <Bot size={29} />
                </div>
                <div className="profile-text">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2>{snapshot?.status.bot?.first_name || 'Your Telegram assistant'}</h2>
                    <span className={`badge ${active ? 'green' : 'neutral'}`}>
                      <span className={`status-dot ${active ? 'green-dot' : ''}`} />
                      {snapshot?.status.state || 'Loading'}
                    </span>
                  </div>
                  <p>
                    {snapshot?.status.bot?.username
                      ? `@${snapshot.status.bot.username} · ${snapshot.status.bot.can_join_groups ? 'Can join groups' : 'Private chats only'} · ${snapshot.status.bot.can_read_all_group_messages ? 'Group messages visible' : 'Group privacy mode enabled'}`
                      : 'Connect your bot token below to bring your workspace to life.'}
                  </p>
                </div>
                <button
                  className="button secondary small-button"
                  disabled={!!busy || !snapshot?.config.enabled}
                  onClick={() =>
                    void action('restart', async () => {
                      const data = await post<Snapshot>('/api/bot/restart');
                      setSnapshot(data);
                    })
                  }
                >
                  <RefreshCw size={14} />
                  Restart poller
                </button>
              </div>
              {snapshot?.status.error && (
                <div className="notice error" role="alert">
                  {snapshot.status.error}
                </div>
              )}
              <div className="settings-grid">
                <section className="card">
                  <div className="card-heading">
                    <span className="icon-box blue">
                      <Settings2 size={20} />
                    </span>
                    <div>
                      <h2>Bot configuration</h2>
                      <p>The essentials, all in one place.</p>
                    </div>
                    <span className="section-number">01</span>
                  </div>
                  <Secret
                    label="Telegram bot token"
                    value={config.token}
                    saved={saved('token')}
                    onChange={(v) => change('token', v)}
                    onClear={() => clear('token')}
                  />
                  <p className="field-help">
                    Create a bot with{' '}
                    <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                      @BotFather <ArrowUpRight size={12} />
                    </a>{' '}
                    and paste its token here.
                  </p>
                  <Toggle
                    label="Enable bot polling"
                    description="Listen for new messages on Telegram."
                    checked={config.enabled}
                    onChange={(v) => change('enabled', v)}
                  />
                  <hr />
                  <Field label="Speech recognition engine">
                    <select
                      value={config.transcribeMode}
                      onChange={(e) =>
                        change('transcribeMode', e.target.value as Config['transcribeMode'])
                      }
                    >
                      <option value="google_asr">Google Chromium ASR · experimental</option>
                      <option value="fastapi">FastAPI / Whisper</option>
                      <option value="gemini">Google Gemini</option>
                    </select>
                  </Field>
                  {config.transcribeMode === 'google_asr' && (
                    <>
                      <Secret
                        label="Google Speech API key (optional override)"
                        value={config.googleSpeechApiKey}
                        saved={saved('googleSpeechApiKey')}
                        onChange={(v) => change('googleSpeechApiKey', v)}
                        onClear={() => clear('googleSpeechApiKey')}
                      />
                      <p className="field-help">
                        Uses the default SpeechRecognition compatibility key when blank. This legacy endpoint may be unavailable.
                        FastAPI and Gemini are alternatives.
                      </p>
                    </>
                  )}
                  {config.transcribeMode === 'fastapi' && (
                    <Field
                      label="Whisper endpoint"
                      hint="Receives multipart file and language fields; returns JSON with text."
                    >
                      <input
                        type="url"
                        value={config.targetApiUrl}
                        onChange={(e) => change('targetApiUrl', e.target.value)}
                      />
                    </Field>
                  )}
                  {config.transcribeMode === 'gemini' && (
                    <>
                      <Secret
                        label="Gemini API key"
                        value={config.geminiApiKey}
                        saved={saved('geminiApiKey')}
                        onChange={(v) => change('geminiApiKey', v)}
                        onClear={() => clear('geminiApiKey')}
                      />
                      <Field label="Gemini model">
                        <input
                          value={config.geminiModel}
                          onChange={(e) => change('geminiModel', e.target.value)}
                        />
                      </Field>
                    </>
                  )}
                  <Field label="Default recognition language">
                    <select
                      value={config.language}
                      onChange={(e) => change('language', e.target.value as Config['language'])}
                    >
                      <option value="fa-IR">Persian · فارسی (fa-IR)</option>
                      <option value="en-US">English · United States (en-US)</option>
                    </select>
                  </Field>
                  <Toggle
                    label="Automatic replies"
                    description="Reply to voice notes with their transcription."
                    checked={config.autoReply}
                    onChange={(v) => change('autoReply', v)}
                  />
                  <Toggle
                    label="Clean up transcripts"
                    description="Use the low-cost Luna model for punctuation, paragraph breaks, and only obvious word fixes. Keep the raw transcript if the model is unavailable or changes too much."
                    checked={config.polishTranscript}
                    onChange={(v) => change('polishTranscript', v)}
                  />
                  <hr />
                  <Field label="Welcome message" hint="Sent when someone uses /start.">
                    <textarea
                      rows={4}
                      value={config.startMessage}
                      onChange={(e) => change('startMessage', e.target.value)}
                      maxLength={3500}
                    />
                  </Field>
                  <div className="info-strip">
                    <ShieldCheck size={16} />
                    <span>Credentials stay on the server and are masked after saving.</span>
                  </div>
                </section>
                <section className="card brain-card">
                  <div className="card-heading">
                    <span className="icon-box peach">
                      <Sparkles size={20} />
                    </span>
                    <div>
                      <h2>AI summary brain</h2>
                      <p>Turn busy chats into the important bits.</p>
                    </div>
                    <span className="section-number">02</span>
                  </div>
                  <div className="brain-options">
                    <button
                      className={`brain-option ${config.llmBrain === 'server_cloud' ? 'chosen' : ''}`}
                      onClick={() => change('llmBrain', 'server_cloud')}
                    >
                      <Cloud size={22} />
                      <strong>Server Cloud</strong>
                      <span>Powered by OpenRouter</span>
                      <small className={snapshot?.readiness.cloud ? 'ready' : ''}>
                        {snapshot?.readiness.cloud ? 'Key configured' : 'API key needed'}
                      </small>
                      {config.llmBrain === 'server_cloud' && (
                        <Check size={13} className="selected-check" />
                      )}
                    </button>
                    <button
                      className={`brain-option ${config.llmBrain === 'chatgpt' ? 'chosen' : ''}`}
                      onClick={() => change('llmBrain', 'chatgpt')}
                    >
                      <Sparkles size={22} />
                      <strong>OpenAI / custom API</strong>
                      <span>Your key. Your models.</span>
                      <small className={snapshot?.readiness.openai ? 'ready' : ''}>
                        {snapshot?.readiness.openai ? 'Key configured' : 'Connect account'}
                      </small>
                      {config.llmBrain === 'chatgpt' && (
                        <Check size={13} className="selected-check" />
                      )}
                    </button>
                  </div>
                  {config.llmBrain === 'chatgpt' && (
                    <div className="provider-panel">
                      <div className="flex items-center justify-between mb-4 gap-2">
                        <h3>OpenAI connection</h3>
                        <a
                          className="text-link"
                          href="https://platform.openai.com/api-keys"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Create API key <ArrowUpRight size={13} />
                        </a>
                      </div>
                      <Secret
                        label="OpenAI API key"
                        value={config.chatGptApiKey}
                        saved={saved('chatGptApiKey')}
                        onChange={(v) => change('chatGptApiKey', v)}
                        onClear={() => clear('chatGptApiKey')}
                      />
                      <div className="flex items-center gap-3 flex-wrap mb-4">
                        <button
                          className="button secondary small-button"
                          disabled={!!busy || (!config.chatGptApiKey && !saved('chatGptApiKey'))}
                          onClick={() => void verify()}
                        >
                          {busy === 'verify' ? (
                            <LoaderCircle className="animate-spin" size={14} />
                          ) : (
                            <KeyRound size={14} />
                          )}
                          Verify & connect
                        </button>
                        {verified && (
                          <span className="badge green">
                            <Check size={12} />
                            {verified}
                          </span>
                        )}
                      </div>
                      <Field
                        label="API base URL"
                        hint="OpenAI or your OpenAI-compatible server, including /v1."
                      >
                        <input
                          type="url"
                          value={config.chatGptBaseUrl}
                          onChange={(e) => change('chatGptBaseUrl', e.target.value)}
                        />
                      </Field>
                      <Field label="Summary model">
                        <input
                          list="summary-models"
                          value={config.chatGptModel}
                          onChange={(e) => change('chatGptModel', e.target.value)}
                        />
                        <datalist id="summary-models">
                          {choices.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </Field>
                      <p className="field-help">
                        API billing is separate from a ChatGPT subscription. Model availability
                        depends on your account.
                      </p>
                    </div>
                  )}
                  <div className="provider-panel">
                    <div className="flex items-center justify-between mb-4 gap-2">
                      <h3>
                        {config.llmBrain === 'chatgpt' ? 'Cloud fallback' : 'OpenRouter connection'}
                      </h3>
                      <a
                        className="text-link"
                        href="https://openrouter.ai/settings/keys"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Get API key <ArrowUpRight size={13} />
                      </a>
                    </div>
                    <Secret
                      label="OpenRouter API key"
                      value={config.openRouterApiKey}
                      saved={saved('openRouterApiKey')}
                      onChange={(v) => change('openRouterApiKey', v)}
                      onClear={() => clear('openRouterApiKey')}
                    />
                    <Field
                      label="Cloud model"
                      hint="Falls back to openrouter/free if the selected model is unavailable."
                    >
                      <input
                        value={config.openRouterModel}
                        onChange={(e) => change('openRouterModel', e.target.value)}
                        placeholder="openrouter/free"
                        list="router-models"
                      />
                      <datalist id="router-models">
                        <option value="openrouter/free" />
                        <option value="qwen/qwen3.8-27b:free" />
                      </datalist>
                    </Field>
                  </div>
                  <div className="prompt-label">
                    <label htmlFor="system-prompt">Summary system prompt</label>
                    <button
                      className="text-button"
                      onClick={() => change('summarySystemPrompt', defaultPrompt)}
                    >
                      <RefreshCw size={12} />
                      Reset to default
                    </button>
                  </div>
                  <textarea
                    id="system-prompt"
                    dir="auto"
                    rows={6}
                    value={config.summarySystemPrompt}
                    maxLength={12000}
                    onChange={(e) => change('summarySystemPrompt', e.target.value)}
                  />
                  <div className="prompt-meta">
                    <span>Shared across both AI providers</span>
                    <span>{config.summarySystemPrompt.length.toLocaleString()} / 12,000</span>
                  </div>
                  <div className="prompt-label mt-5">
                    <label htmlFor="education-prompt">Education system prompt</label>
                    <button
                      className="text-button"
                      onClick={() => change('educationSystemPrompt', defaultEducationPrompt)}
                    >
                      <RefreshCw size={12} />
                      Reset to default
                    </button>
                  </div>
                  <textarea
                    id="education-prompt"
                    dir="auto"
                    rows={10}
                    value={config.educationSystemPrompt}
                    maxLength={12000}
                    onChange={(e) => change('educationSystemPrompt', e.target.value)}
                  />
                  <div className="prompt-meta">
                    <span>Used for /education in every group</span>
                    <span>{config.educationSystemPrompt.length.toLocaleString()} / 12,000</span>
                  </div>
                  <button
                    className="button secondary w-full mt-5"
                    disabled={!!busy}
                    onClick={() => void test()}
                  >
                    {busy === 'summary' ? (
                      <LoaderCircle className="animate-spin" size={16} />
                    ) : (
                      <Play size={16} />
                    )}{' '}
                    {busy === 'summary'
                      ? 'Summarizing sample conversation…'
                      : 'Test conversation summary'}
                  </button>
                  <p className="footnote">
                    Uses the settings above with a sample Persian conversation.
                  </p>
                  {summary && (
                    <div className="summary-preview">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="badge green">
                          <Check size={12} />
                          Complete
                        </span>
                        <span className="text-xs text-slate-500">
                          {summary.provider} · {(summary.durationMs / 1000).toFixed(1)}s
                          {summary.fallback ? ' · fallback used' : ''}
                        </span>
                      </div>
                      <p dir="auto">{summary.text}</p>
                      <small>{summary.model}</small>
                    </div>
                  )}
                </section>
              </div>
              <div className="command-strip">
                <span className="icon-box mint">
                  <MessageSquare size={19} />
                </span>
                <div>
                  <strong>A whole conversation. One command.</strong>
                  <p>
                    Send <code>/summary</code> for the latest 50 messages, or <code>/summary 100</code>{' '}
                    for a longer summary.
                  </p>
                  <p>
                    Reply to an Education PDF with <code>/question Your question</code> to ask about its notes.
                  </p>
                  <p>
                    Reply to an Education PDF with a photo captioned <code>/image</code> to add picture content.
                  </p>
                </div>
                <span className="badge neutral">Up to 100 messages</span>
              </div>
            </>
          )}
          {tab === 'audience' && (
            <section className="card audience-card">
              <div className="card-heading">
                <span className="icon-box blue">
                  <Users size={20} />
                </span>
                <div>
                  <h2>Your conversation directory</h2>
                  <p>
                    {metrics?.uniqueUsers || 0} unique participants active in the last 30 days
                    {metrics?.pdfTrackingStartedAt
                      ? ` · PDF counts since ${new Date(metrics.pdfTrackingStartedAt).toLocaleDateString()}`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="directory-tools">
                <div className="search-input">
                  <Search size={17} />
                  <input
                    aria-label="Search chats"
                    value={search}
                    placeholder="Search by name or chat ID…"
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  aria-label="Filter chats"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All conversations</option>
                  <option value="groups">Groups only</option>
                  <option value="private">Private users</option>
                  <option value="group-pdfs">Groups with PDFs</option>
                  <option value="private-pdfs">Private chats with PDFs</option>
                </select>
              </div>
              {chats.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Conversation</th>
                        <th>Messages / audio</th>
                        <th>PDFs generated</th>
                        <th>Language</th>
                        <th>Last active</th>
                        <th>Controls</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chats.map((chat) => (
                        <tr key={chat.id}>
                          <td>
                            <div className="chat-title">
                              <span className="chat-avatar">
                                {chat.type === 'private' ? (
                                  <MessageSquare size={17} />
                                ) : (
                                  <Users size={17} />
                                )}
                              </span>
                              <div>
                                <strong>{chat.title}</strong>
                                <small>
                                  {chat.id} ·{' '}
                                  {chat.memberCount === null
                                    ? chat.type
                                    : `${chat.memberCount} members`}
                                </small>
                                <small>GIF/sticker replies: {chat.describeMedia ? 'On' : 'Off'}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            {chat.messageCount.toLocaleString()}{' '}
                            <span className="text-slate-400">/ {chat.audioCount}</span>
                            <small>
                              {chat.dailyMessages?.[new Date().toISOString().slice(0, 10)] || 0}{' '}
                              messages today (UTC)
                            </small>
                          </td>
                          <td>
                            {chat.pdfCount.toLocaleString()}
                            <small>
                              {chat.lastPdfAt
                                ? `Latest ${new Date(chat.lastPdfAt).toLocaleString()}`
                                : 'No PDFs yet'}
                            </small>
                          </td>
                          <td>
                            <select
                              aria-label={`Language for ${chat.title}`}
                              value={chat.language}
                              disabled={!!busy}
                              onChange={(e) =>
                                void updateChat(chat.id, { language: e.target.value })
                              }
                            >
                              <option value="fa-IR">Persian</option>
                              <option value="en-US">English</option>
                            </select>
                          </td>
                          <td className="whitespace-nowrap">
                            {new Date(chat.lastActive).toLocaleDateString()}
                            <small>
                              {new Date(chat.lastActive).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </small>
                          </td>
                          <td>
                            <button
                              className={`badge badge-button ${chat.enabled ? 'green' : 'neutral'}`}
                              disabled={!!busy}
                              onClick={() => void updateChat(chat.id, { enabled: !chat.enabled })}
                            >
                              {chat.enabled ? 'Active · pause' : 'Paused · enable'}
                            </button>
                            <button
                              className="text-button mt-2"
                              disabled={!!busy}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Delete stored conversation history for ${chat.title}?`,
                                  )
                                )
                                  void updateChat(chat.id, { clearHistory: true });
                              }}
                            >
                              Clear history
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="directory-empty">
                  <span className="empty-circle">
                    <Users size={32} />
                  </span>
                  <h3>
                    {search || filter !== 'all'
                      ? 'No matching conversations'
                      : 'Your audience starts with a hello.'}
                  </h3>
                  <p>
                    {search || filter !== 'all'
                      ? 'Try another search or show all conversations.'
                      : 'Connect your bot, then send it a message or add it to a group. Conversations will appear here automatically.'}
                  </p>
                  {!search && (
                    <button className="button secondary mt-5" onClick={() => setTab('bot')}>
                      Configure your bot <ArrowUpRight size={15} />
                    </button>
                  )}
                </div>
              )}
              <div className="info-strip">
                <Globe2 size={16} />
                <span>
                  Group language changes apply to future audio. Paused chats are counted but are not
                  transcribed or stored in summary history.
                </span>
              </div>
            </section>
          )}
          {tab === 'audio' && (
            <AudioLab
              language={config.language}
              onComplete={() => {
                void refresh().catch(() => {});
              }}
            />
          )}
          <section className="console">
            <div className="console-heading">
              <div>
                <Terminal size={17} />
                <h2>Live activity</h2>
                <span className={`console-status ${live ? 'connected' : ''}`}>
                  <span className="status-dot" />
                  {live ? 'LIVE' : 'RECONNECTING'}
                </span>
              </div>
              <button className="text-button" onClick={() => setLogs([])}>
                Clear view
              </button>
            </div>
            <div className="console-body" role="log" aria-label="Bot activity log">
              {logs.length ? (
                logs
                  .slice(-12)
                  .reverse()
                  .map((log) => (
                    <div className={`log-line ${log.level}`} key={log.id}>
                      <time>{new Date(log.time).toLocaleTimeString([], { hour12: false })}</time>
                      <span className="log-level">
                        {log.level === 'info' ? (
                          <ArrowDownLeft size={13} />
                        ) : (
                          <Activity size={13} />
                        )}{' '}
                        {log.level.toUpperCase()}
                      </span>
                      <span>{log.message}</span>
                    </div>
                  ))
              ) : (
                <div className="console-empty">
                  <Radio size={16} />
                  {live
                    ? 'Connected. Waiting for the next conversation…'
                    : 'Connecting to the activity stream…'}
                </div>
              )}
            </div>
            <div className="console-footer">
              <span>Event stream · last 200 events retained in memory</span>
              <span>Credentials and message contents are excluded</span>
            </div>
          </section>
          <footer className="page-footer">
            <span>
              <Logo small />
              Made for the moments between messages.
            </span>
            <span>
              Voice Studio <span className="text-slate-300 mx-2">/</span> v1.0
            </span>
          </footer>
        </main>
      </div>
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
            className="modal card"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              autoFocus
              aria-label="Close setup guide"
              onClick={() => setHelp(false)}
            >
              <X size={20} />
            </button>
            <span className="icon-box peach">
              <Sparkles size={22} />
            </span>
            <h2 id="guide-title" className="mt-5">
              A few steps to your first transcript
            </h2>
            <ol className="setup-steps">
              <li>
                <strong>Connect Telegram</strong>
                <p>
                  Create a bot with @BotFather, paste its token, enable polling and save. Only one
                  instance can poll a token.
                </p>
              </li>
              <li>
                <strong>Choose a speech provider</strong>
                <p>
                  Add a Gemini or compatible Google key, or connect your Whisper endpoint. Test it
                  in the audio playground.
                </p>
              </li>
              <li>
                <strong>Connect the summary brain</strong>
                <p>
                  Add an OpenRouter or OpenAI API key. Run a test summary, then save. Free models
                  still require credentials and available quota.
                </p>
              </li>
              <li>
                <strong>Invite your bot</strong>
                <p>
                  For full group summaries, turn off privacy mode with /setprivacy in BotFather and
                  re-add the bot if required. Let group members know audio and conversation excerpts
                  go to your configured AI providers.
                </p>
              </li>
            </ol>
            <div className="notice">
              Recent history is limited to 200 messages per chat and 30 days. You can clear it in
              Audience & groups.
            </div>
            <button className="button primary w-full" onClick={() => setHelp(false)}>
              Let’s get started <ChevronRight size={16} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
