# LatentMail

A cross-platform desktop email client with Gmail (IMAP/OAuth2), optional local AI and **semantic search** via [Ollama](https://ollama.com). Built with Electron and Angular. **All data is stored locally in a SQLite database**; the only remote communication is with your IMAP (and SMTP) server.

**This project was written entirely by AI** — mostly [Claude](https://claude.ai) (Anthropic), with some assistance from other AI coding tools. It serves as a working example of an AI-generated desktop application.

---

## What it does

- **Email**: Connect Gmail accounts via OAuth2; read, search, and manage mail over IMAP. Compose and send with SMTP. **Everything—mail metadata, folders, threads, search index—lives in a local SQLite DB on your machine.** The app talks only to your IMAP/SMTP server; no other servers see your mail.
- **Operation queue**: Drafts, send, move, flag, and delete are processed through an in-process queue (one at a time per account) so they run in order. The queue is in-memory only and does not persist across app restarts.
- **Local AI** (optional): If you run [Ollama](https://ollama.com) locally, the client can use it for summarization and other AI features; no data leaves your machine.
- **Semantic search** (optional): With Ollama and an embedding model (e.g. `nomic-embed-text`) configured in **Settings → AI**, you can build a local vector index of your mail. Search then uses natural-language similarity (e.g. “emails about project deadlines”) and returns results by meaning; if the index is missing or returns too few hits, the app falls back to keyword search. The index is stored in a separate SQLite DB (`latentmail-vectors.db`) using the [sqlite-vec](https://github.com/asg017/sqlite-vec) extension.
- **Desktop-native**: Runs on Windows, macOS, and Linux. Credentials are stored with the OS (e.g. Windows DPAPI, macOS Keychain). On Windows, an optional native addon restores drag-and-drop for attachments when using recent Electron/Chromium.

---

## How it works (high level)

- **Electron** hosts a **main process** (Node.js) and a **renderer** (Angular in a browser window). They talk only over IPC; the UI never touches the database or network directly.
- The main process uses a **local SQLite database** (via sql.js) for all storage—mail, folders, threads, search index, settings. The only network communication is with your **IMAP server** (and SMTP for sending). OAuth is used once to obtain tokens; credentials are stored locally with the OS.
- Mail is synced from the IMAP server into SQLite; the app reads and writes only from the local DB, so it stays responsive and your data stays on your machine.
- **Semantic search** (optional): If you enable an embedding model in Settings → AI, the app can build a vector index of email body text in a second DB (`latentmail-vectors.db`) using sqlite-vec. When you search, the query is embedded and compared to stored vectors; the best-matching emails are returned. The index is built in a worker thread and can be started or cancelled from Settings; if the index is empty or similarity results are insufficient, search falls back to keyword matching.

---

## Prerequisites

- **Node.js** 20+ (e.g. v24)
- **Yarn** 1.x: `npm install -g yarn`
- **Google OAuth2 client** (for Gmail login): See **Google OAuth setup** below for how to get the Client ID and secret and save them in `electron/secrets.ts`.
- **Ollama** (optional): [ollama.com](https://ollama.com) for local AI features. For semantic search, pull an embedding-capable model (e.g. `ollama pull nomic-embed-text`) and select it under **Settings → AI**.

---

## Google OAuth setup (client ID & secret)

Gmail login uses Google OAuth 2.0. You need to create a **Desktop** OAuth client and put its credentials in the app's secrets file.

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth 2.0 Client ID** (or use an existing one). Set the application type to **Desktop app**.
3. Copy the **Client ID** and **Client secret**.
4. In this repo, credentials are read from **`electron/secrets.ts`** (git-ignored). After `yarn install`, that file is created from `electron/secrets.example.ts` if it doesn't exist. Open `electron/secrets.ts` and set:
   - `GOOGLE_CLIENT_ID` — your Desktop client's Client ID  
   - `GOOGLE_CLIENT_SECRET` — your Desktop client's Client secret  

Do not commit `electron/secrets.ts` or put real values in `secrets.example.ts`. Your keys stay only in `secrets.ts`.

---

## Installation & running

### From source

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/mailclient.git
cd mailclient

# Install dependencies (creates electron/secrets.ts from example if missing)
yarn install

# Add your Google OAuth Client ID and Client secret to electron/secrets.ts (see Google OAuth setup above)

# Run in development (Angular dev server + Electron)
yarn electron:dev
```

For a **packaged build** (installer/portable app):

```bash
yarn package    # Unpacked app in out/
# or
yarn make       # Platform installer (e.g. NSIS on Windows, DMG on macOS)
```

Output goes to the `out/` directory.

### Windows: drag-and-drop (optional)

On Windows, OS file drag-and-drop for attachments is fixed by a small native addon. To build it:

1. Install **Visual Studio Build Tools** with the “Desktop development with C++” workload, and **Python 3.x**.
2. From the project root:

```bash
yarn build:native
```

Then run or package as above. If you skip this step, the app still runs; only dragging files from the OS into the window won’t work on Windows. macOS and Linux do not need this addon.

---

## Scripts

| Command | Description |
|--------|-------------|
| `yarn electron:dev` | Run app in development (hot-reload) |
| `yarn electron:start` | Build and run packaged app |
| `yarn package` | Build and output unpacked app to `out/` |
| `yarn make` | Build platform installer (e.g. `.exe`, `.dmg`) |
| `yarn test` | Run Angular unit tests |

---

## Tech stack (summary)

- **Shell**: Electron  
- **Frontend**: Angular (standalone components, signals), Angular Material  
- **State**: NgRx SignalStore  
- **Backend**: Node.js, SQLite (sql.js), IMAP/SMTP, OAuth2, Electron `safeStorage`; optional vector index (better-sqlite3 + [sqlite-vec](https://github.com/asg017/sqlite-vec)) for semantic search  
- **Build**: Electron Builder  

For detailed architecture, development, and conventions, see [AGENTS.md](AGENTS.md) (written for AI and human contributors).

---

## License

[MIT](LICENSE)
