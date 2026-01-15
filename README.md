# Genie CLI

Code on the go — control AI coding agents from your mobile device.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g genie-cli
```

## Usage

### Claude (default)

```bash
genie
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

### Gemini

```bash
genie gemini
```

Start a Gemini CLI session with remote control capabilities.

**First time setup:**
```bash
# Authenticate with Google
genie connect gemini
```

## Commands

### Main Commands

- `genie` – Start Claude Code session (default)
- `genie gemini` – Start Gemini CLI session
- `genie codex` – Start Codex mode

### Utility Commands

- `genie auth` – Manage authentication
- `genie connect` – Store AI vendor API keys in Genie cloud
- `genie notify` – Send a push notification to your devices
- `genie daemon` – Manage background service
- `genie doctor` – System diagnostics & troubleshooting

### Connect Subcommands

```bash
genie connect gemini     # Authenticate with Google for Gemini
genie connect claude     # Authenticate with Anthropic
genie connect codex      # Authenticate with OpenAI
genie connect status     # Show connection status for all vendors
```

### Gemini Subcommands

```bash
genie gemini                      # Start Gemini session
genie gemini model set <model>    # Set default model
genie gemini model get            # Show current model
genie gemini project set <id>     # Set Google Cloud Project ID (for Workspace accounts)
genie gemini project get          # Show current Google Cloud Project ID
```

**Available models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`

## Options

### Claude Options

- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

### Global Options

- `-h, --help` - Show help
- `-v, --version` - Show version

## Environment Variables

### Genie Configuration

- `GENIE_RELAY_SERVER_URL` - Custom relay server URL
- `GENIE_CONTENT_SERVER_URL` - Custom backend server URL
- `GENIE_HOME_DIR` - Custom home directory for Genie data (default: ~/.genie)
- `GENIE_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `GENIE_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

### Gemini Configuration

- `GEMINI_MODEL` - Override default Gemini model
- `GOOGLE_CLOUD_PROJECT` - Google Cloud Project ID (required for Workspace accounts)

### OIDC Configuration

- `GENIE_OIDC_SCOPES` - Custom OIDC scopes (space-separated)

## Deva SSO Authentication

Genie CLI uses Deva SSO for authentication via OIDC with PKCE (Proof Key for Code Exchange).

### Authentication Flow

1. Run `genie auth` to start authentication
2. A browser opens to the Deva SSO login page
3. After login, the authorization code is exchanged for tokens
4. Tokens are stored in `~/.genie/deva_credentials.json`

### OAuth Flow (PKCE)

```
┌─────────────┐     1. Generate code_verifier + code_challenge (S256)
│  Genie CLI  │────────────────────────────────────────────────────────►
│             │
│             │     2. Open browser: /sso/authorize?code_challenge=...
│             │────────────────────────────────────────────────────────►
│             │                                                    ┌──────────────┐
│             │     3. User authenticates                          │   Deva SSO   │
│             │◄───────────────────────────────────────────────────│              │
│             │     4. Receive authorization_code                  └──────────────┘
│             │
│             │     5. POST /oidc/token (code + code_verifier)
│             │────────────────────────────────────────────────────────►
│             │                                                    ┌──────────────┐
│             │     6. Receive tokens (id_token, access_token,     │Content Server│
│             │◄───────────────────────────────────────────────────│              │
└─────────────┘        refresh_token)                              └──────────────┘
```

### OIDC Scopes

Default scopes requested during authentication:

| Scope | Description |
|-------|-------------|
| `OPENID` | OpenID Connect authentication |
| `USER:READ` | Read user profile |
| `PERSONA:READ` | Read persona information |
| `PERSONA:PUBLIC_READ` | Read public persona data |
| `GENIE_MACHINE:READ` | Read machine information |
| `GENIE_MACHINE:CREATE` | Register new machines |
| `GENIE_MACHINE:UPDATE` | Update machine status |
| `GENIE_MACHINE:DELETE` | Remove machines |
| `GENIE_SESSION:READ` | Read session data |
| `GENIE_SESSION:CREATE` | Create new sessions |
| `GENIE_SESSION:UPDATE` | Update session state |
| `GENIE_SESSION:DELETE` | Delete sessions |
| `GENIE_SESSION_MESSAGE:READ` | Read session messages |
| `GENIE_SESSION_MESSAGE:CREATE` | Send messages |
| `GENIE_SESSION_MESSAGE:UPDATE` | Update messages |
| `GENIE_SESSION_MESSAGE:DELETE` | Delete messages |

### Token Storage

Credentials are stored in `~/.genie/deva_credentials.json`:

Tokens are automatically refreshed when expired.

## Gemini Authentication

### Personal Google Account

Personal Gmail accounts work out of the box:

```bash
genie connect gemini
genie gemini
```

### Google Workspace Account

Google Workspace (organization) accounts require a Google Cloud Project:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Gemini API
3. Set the project ID:

```bash
genie gemini project set your-project-id
```

Or use environment variable:
```bash
GOOGLE_CLOUD_PROJECT=your-project-id genie gemini
```

**Guide:** https://goo.gle/gemini-cli-auth-docs#workspace-gca

## Contributing

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Requirements

- Node.js >= 20.0.0

### For Claude

- Claude CLI installed & logged in (`claude` command available in PATH)

### For Gemini

- Gemini CLI installed (`npm install -g @google/gemini-cli`)
- Google account authenticated via `genie connect gemini`

## License

MIT
