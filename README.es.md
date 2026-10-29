# infuture IA

[English](README.md) · **Español**

infuture IA es un centro de mando open source para agentes de IA. Conecta OpenAI, Anthropic, Groq u Ollama, reparte el trabajo entre agentes especializados y mira en vivo qué piensa cada uno, qué herramientas usa y cuánto cuesta.

> Estado: **Fase 7 · Configuración, Colaboración 3D y Observatorio.** Las personas de agentes, prompts bilingües, permisos de herramientas, pizarra interactiva 3D, acciones de puesto y filtrado del flujo de eventos están operativos.

## Requisitos

- Node.js 22 o superior
- pnpm 10 (`corepack enable` instala la versión fijada en `package.json`)
- Docker Desktop, para PostgreSQL y Redis

## Inicio rápido

```bash
corepack enable
pnpm install
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
pnpm vault:key                # pega la línea que imprime en .env
docker compose up -d          # PostgreSQL y Redis
pnpm db:migrate               # crea las tablas
pnpm dev                      # API en :4000, web en :5173
```

Abre http://localhost:5173 y cambia entre **English** y **Español** en la barra superior. Añade `?lang=es` a cualquier URL para abrirla en español.

## Estructura del repositorio

```
apps/
  api/          API HTTP con Fastify, responde en el idioma del cliente
  web/          App React + Vite (panel, terminal interactiva y oficina 3D con Three.js)
packages/
  i18n/         Catálogos en inglés y español, negociación de idioma y formato de números, monedas y fechas
  events/       Envoltorio de eventos, catálogo de eventos y protocolo del socket en tiempo real (Zod)
  vault/        Cifrado por sobre de las credenciales de proveedores y redacción de secretos
  providers/    Manifiestos de OpenAI, Anthropic, Groq y Ollama, y comprobación de conexiones
  worker/       Ejecutor de agentes worker, roles y ciclo de vida de eventos
  db/           Esquema y migraciones de PostgreSQL (Drizzle ORM)
```

Los paquetes del workspace se comparten como código TypeScript. Vite los empaqueta para la web y esbuild los empaqueta en `apps/api/dist` para producción.

## Comandos

| Comando            | Qué hace                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `pnpm dev`         | Levanta la API y la web con recarga en caliente                   |
| `pnpm build`       | Compila todas las apps                                            |
| `pnpm check`       | Lint, verificación de tipos y tests                               |
| `pnpm test`        | Tests unitarios (Vitest)                                          |
| `pnpm format`      | Formatea el código con Prettier                                   |
| `pnpm db:generate` | Crea una migración después de cambiar `packages/db/src/schema.ts` |
| `pnpm db:migrate`  | Aplica las migraciones pendientes                                 |
| `pnpm db:studio`   | Abre Drizzle Studio para explorar la base de datos                |
| `pnpm vault:key`   | Imprime una nueva `INFUTURE_MASTER_KEY`                           |
| `pnpm terminal`    | Abre la terminal interactiva en consola                           |

## Idiomas

infuture IA viene en inglés y español, y todas las capas usan los mismos catálogos de `packages/i18n/src/locales`:

- **Web:** react-i18next. El idioma sale de `?lang=`, luego de la elección guardada y luego del navegador. Las claves se verifican con tipos, así que un error en una clave rompe la compilación.
- **API:** las respuestas y los errores siguen `?lang=`, luego la cabecera `X-Infuture-Locale`, luego `Accept-Language`, y devuelven `Content-Language`.
- **Datos:** usuarios, workspaces y ejecuciones guardan su idioma; los roles tienen nombre y prompt de sistema por idioma, para que los agentes respondan en el idioma de la ejecución.
- **Tests:** un test falla si a un idioma le falta una clave, tiene un texto vacío o usa `{{variables}}` distintas a las del inglés.

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para añadir textos o un idioma nuevo.

## Hoja de ruta

0. **Cimientos:** monorepo, base de datos, idiomas ✓
1. **Proveedores y credenciales cifradas** ✓
2. **Un primer worker que emite eventos** ✓
3. **Eventos en vivo y dashboard** ✓
4. **Multiagente, routing de modelos y supervisión** ✓
5. **Terminal y oficina 3D** ✓
6. **Herramientas (tools), aprobaciones humanas y watchdog** ✓
7. **Configuración y editor de roles de agentes personalizados** ✓
8. **Recetas de agentes, playbooks y motor de automatizaciones programadas** ✓
9. **Control interactivo de ejecuciones, retroalimentación humana y suite de exportación de informes** ✓
10. **Integración con Model Context Protocol (MCP) y estudio de herramientas personalizadas** ✓
11. **Memoria de agentes, base de conocimiento a largo plazo y recuperación semántica (RAG)** ✓
12. **Espacios de trabajo multinquilino, tokens de acceso API con permisos y despachador de webhooks firmados con HMAC** ✓

## Licencia

[GNU Affero General Public License v3.0](LICENSE). Puedes usar, modificar y autohospedar infuture IA libremente; si ofreces una versión modificada como servicio en red, debes publicar tus cambios.
