# infuture IA

**English** · [Español](README.es.md)

infuture IA is an open-source command center for AI agents. Connect OpenAI, Anthropic, Groq or Ollama, split work between specialized agents, and watch live what each one thinks, which tools it uses and what it costs.

> Status: **Phase 7 · Settings, 3D Collaboration & Stream Observatory.** Agent personas, bilingual system prompts, tool permissions, interactive 3D whiteboard, desk actions and event stream filtering are operational.

## Requirements

- Node.js 22 or newer
- pnpm 10 (`corepack enable` installs the version pinned in `package.json`)
- Docker Desktop, for PostgreSQL and Redis

## Quick start

```bash
corepack enable
pnpm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
pnpm vault:key                # paste the printed line into .env
docker compose up -d          # PostgreSQL and Redis
pnpm db:migrate               # create the tables
pnpm dev                      # API on :4000, web on :5173
```

Open http://localhost:5173 and switch between **English** and **Español** in the top bar. Add `?lang=es` to any URL to open it in Spanish.

## Repository layout

```
apps/
  api/          Fastify HTTP API, answers in the client's language
  web/          React + Vite app (dashboard, interactive terminal and 3D office with Three.js)
packages/
  i18n/         English and Spanish catalogs, language negotiation, number/currency/date formatting
  events/       Event envelope, event catalog and realtime socket protocol (Zod)
  vault/        Envelope encryption for provider credentials and secret redaction
  providers/    Manifests for OpenAI, Anthropic, Groq and Ollama, and connection checks
  worker/       Worker agent runtime, roles and event lifecycle execution
  db/           PostgreSQL schema and migrations (Drizzle ORM)
```

Workspace packages are shared as TypeScript source. Vite bundles them for the web app and esbuild bundles them into `apps/api/dist` for production.

## Scripts

| Command            | What it does                                                     |
| ------------------ | ---------------------------------------------------------------- |
| `pnpm dev`         | Runs the API and the web app with hot reload                     |
| `pnpm build`       | Builds every app                                                 |
| `pnpm check`       | Lint, type check and tests                                       |
| `pnpm test`        | Unit tests (Vitest)                                              |
| `pnpm format`      | Formats the code with Prettier                                   |
| `pnpm db:generate` | Creates a migration after you change `packages/db/src/schema.ts` |
| `pnpm db:migrate`  | Applies pending migrations                                       |
| `pnpm db:studio`   | Opens Drizzle Studio to browse the database                      |
| `pnpm vault:key`   | Prints a new `INFUTURE_MASTER_KEY`                               |
| `pnpm terminal`    | Opens the interactive command center terminal in shell           |

## Languages

infuture IA ships in English and Spanish, and every layer uses the same catalogs in `packages/i18n/src/locales`:

- **Web:** react-i18next. The language comes from `?lang=`, then the saved choice, then the browser. Keys are type-checked, so a typo fails the build.
- **API:** answers and error messages follow `?lang=`, then the `X-Infuture-Locale` header, then `Accept-Language`, and send `Content-Language` back.
- **Data:** users, workspaces and runs store their language; roles keep their name and system prompt per language, so agents answer in the run's language.
- **Tests:** a test fails if a language is missing a key, has an empty string or uses different `{{placeholders}}` than English.

See [CONTRIBUTING.md](CONTRIBUTING.md) to add strings or a new language.

## Roadmap

0. **Foundations:** monorepo, database, languages ✓
1. **Providers and encrypted credentials** ✓
2. **A first worker that emits events** ✓
3. **Live events and dashboard** ✓
4. **Multi-agent work, model routing and supervision** ✓
5. **Terminal and 3D office** ✓
6. **Tools, human approvals and watchdog supervision** ✓
7. **Settings and custom agent roles editor** ✓
8. **Agent recipes, playbooks and scheduled automations engine** ✓
9. **Interactive run steering, human feedback and report export suite** ✓
10. **Model Context Protocol (MCP) integration and custom tools studio** ✓
11. **Agent memory, long-term knowledge base and semantic retrieval (RAG)** ✓
12. **Multi-tenant workspaces, scoped API access tokens and HMAC-signed webhooks dispatcher** ✓

## License

[GNU Affero General Public License v3.0](LICENSE). You can use, modify and self-host infuture IA freely; if you offer a modified version as a network service, you must publish your changes.
