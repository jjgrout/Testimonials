import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type SearchFile = {
  extension: string;
  fileName: string;
  key: string;
  lastModified?: string;
  size?: number;
  supported: boolean;
};

type GeneratedDocument = {
  fileName: string;
  key: string;
  textLength: number;
};

type User = {
  username: string;
};

const api = {
  async exportPdf(identifier: string, testimonial: string): Promise<Blob> {
    const response = await fetch("/api/export/pdf", {
      body: JSON.stringify({ identifier, testimonial }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST"
    });
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    return response.blob();
  },
  async generate(
    identifier: string,
    keys: string[],
    additionalInstructions: string
  ): Promise<{ documents: GeneratedDocument[]; testimonial: string }> {
    const response = await fetch("/api/testimonial/generate", {
      body: JSON.stringify({ additionalInstructions, identifier, keys }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST"
    });
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    return response.json();
  },
  async login(username: string, password: string): Promise<User> {
    const response = await fetch("/api/login", {
      body: JSON.stringify({ password, username }),
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST"
    });
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    return response.json();
  },
  async logout(): Promise<void> {
    await fetch("/api/logout", {
      credentials: "include",
      method: "POST"
    });
  },
  async me(): Promise<User | undefined> {
    const response = await fetch("/api/me", { credentials: "include" });
    if (response.status === 401) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    return response.json();
  },
  async search(identifier: string): Promise<SearchFile[]> {
    const response = await fetch(`/api/files/search?identifier=${encodeURIComponent(identifier)}`, {
      credentials: "include"
    });
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    const data = (await response.json()) as { files: SearchFile[] };
    return data.files;
  }
};

function App() {
  const [user, setUser] = useState<User | undefined>();
  const [loadingSession, setLoadingSession] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoadingSession(false));
  }, []);

  if (loadingSession) {
    return <main className="app-shell">Loading private session...</main>;
  }

  if (!user) {
    return (
      <Login
        error={error}
        onLogin={(nextUser) => {
          setError(undefined);
          setUser(nextUser);
        }}
      />
    );
  }

  return (
    <Workspace
      user={user}
      onLogout={async () => {
        await api.logout();
        setUser(undefined);
      }}
    />
  );
}

function Login({
  error,
  onLogin
}: {
  error?: string;
  onLogin: (user: User) => void;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setLocalError(undefined);
    try {
      onLogin(await api.login(username, password));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Unable to sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">Private network access</p>
        <h1>ADF Testimonial Generator</h1>
        <p>
          Sign in with the username and password stored in AWS Secrets Manager for this
          deployment.
        </p>
        <form onSubmit={submit}>
          <label>
            Username
            <input
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
              required
              value={username}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {localError && <div className="error">{localError}</div>}
          <button disabled={busy} type="submit">
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Workspace({ user, onLogout }: { user: User; onLogout: () => Promise<void> }) {
  const [identifier, setIdentifier] = useState("");
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [files, setFiles] = useState<SearchFile[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [testimonial, setTestimonial] = useState("");
  const [usedDocuments, setUsedDocuments] = useState<GeneratedDocument[]>([]);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const selectedFiles = useMemo(
    () => files.filter((file) => selectedKeys.has(file.key)),
    [files, selectedKeys]
  );
  const wordCount = useMemo(
    () => testimonial.trim().split(/\s+/).filter(Boolean).length,
    [testimonial]
  );

  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy("Searching S3...");
    setError(undefined);
    setTestimonial("");
    setUsedDocuments([]);
    setSelectedKeys(new Set());
    try {
      setFiles(await api.search(identifier));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(undefined);
    }
  }

  async function generate() {
    setBusy("Parsing documents and generating testimonial...");
    setError(undefined);
    try {
      const result = await api.generate(identifier, Array.from(selectedKeys), additionalInstructions);
      setTestimonial(result.testimonial);
      setUsedDocuments(result.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setBusy(undefined);
    }
  }

  async function exportPdf() {
    setBusy("Creating PDF...");
    setError(undefined);
    try {
      const blob = await api.exportPdf(identifier, testimonial);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${identifier || "testimonial"}-testimonial.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF export failed");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Controlled VPC application</p>
          <h1>ADF Service Testimonial Generator</h1>
        </div>
        <div className="user-menu">
          <span>{user.username}</span>
          <button className="secondary" onClick={onLogout} type="button">
            Sign out
          </button>
        </div>
      </header>

      {error && <div className="error banner">{error}</div>}
      {busy && <div className="status banner">{busy}</div>}

      <section className="grid">
        <div className="panel">
          <h2>1. Search source files</h2>
          <form className="search-row" onSubmit={search}>
            <label>
              Person identifier
              <input
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="Enter identifier from file title"
                required
                value={identifier}
              />
            </label>
            <button disabled={Boolean(busy)} type="submit">
              Search S3
            </button>
          </form>
          <p className="hint">
            Searches the configured <code>s3://jta-data-bucket/JTA data set/</code> prefix by
            object title. Supported image files and scanned PDFs/TIFFs are OCR processed with
            Textract, including printed and handwritten text where detectable.
          </p>

          <div className="file-list">
            {files.length === 0 && <p className="empty">No files loaded yet.</p>}
            {files.map((file) => (
              <label className={!file.supported ? "file unsupported" : "file"} key={file.key}>
                <input
                  checked={selectedKeys.has(file.key)}
                  disabled={!file.supported}
                  onChange={(event) => {
                    const next = new Set(selectedKeys);
                    if (event.target.checked) {
                      next.add(file.key);
                    } else {
                      next.delete(file.key);
                    }
                    setSelectedKeys(next);
                  }}
                  type="checkbox"
                />
                <span>
                  <strong>{file.fileName}</strong>
                  <small>
                    {file.extension || "no extension"} · {formatBytes(file.size)} ·{" "}
                    {file.lastModified ? new Date(file.lastModified).toLocaleDateString() : ""}
                    {!file.supported ? " · unsupported" : ""}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>2. Generate testimonial</h2>
          <label>
            Optional generation instructions
            <textarea
              className="instructions"
              onChange={(event) => setAdditionalInstructions(event.target.value)}
              placeholder="Example: emphasise leadership and mentoring where supported by the files."
              value={additionalInstructions}
            />
          </label>
          <div className="selection-summary">
            <strong>{selectedFiles.length}</strong> selected file{selectedFiles.length === 1 ? "" : "s"}
          </div>
          <button
            disabled={Boolean(busy) || selectedFiles.length === 0}
            onClick={generate}
            type="button"
          >
            Generate 250-350 word testimonial
          </button>

          {usedDocuments.length > 0 && (
            <div className="used-documents">
              <h3>Used context</h3>
              <ul>
                {usedDocuments.map((document) => (
                  <li key={document.key}>
                    {document.fileName} <span>({document.textLength.toLocaleString()} chars)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section className="panel editor-panel">
        <div className="editor-header">
          <div>
            <h2>3. Review and edit final text</h2>
            <p className="hint">Edit the generated testimonial before exporting the PDF.</p>
          </div>
          <div className={wordCount < 250 || wordCount > 350 ? "word-count warning" : "word-count"}>
            {wordCount} words
          </div>
        </div>
        <textarea
          className="testimonial-editor"
          onChange={(event) => setTestimonial(event.target.value)}
          placeholder="Generated testimonial text will appear here."
          value={testimonial}
        />
        <div className="actions">
          <button disabled={Boolean(busy) || !testimonial.trim()} onClick={exportPdf} type="button">
            Export formatted PDF
          </button>
        </div>
      </section>
    </main>
  );
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

function formatBytes(value?: number): string {
  if (value === undefined) {
    return "unknown size";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
