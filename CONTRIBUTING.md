# Contributing / Contribuir

**English** below · [Español](#español)

## English

### Before you open a pull request

```bash
pnpm check     # lint + type check + tests
pnpm format
```

### Text and languages

Every string a person reads lives in `packages/i18n/src/locales/en.json` and `es.json`. Never hard-code text in components or API responses.

1. Add the key to `en.json` (the source of truth for the shape).
2. Add the same key to `es.json`.
3. Use it: `t("home.title")` in React, `request.t("home.title")` in the API, `translate(locale, "home.title")` anywhere else.
4. Variables use `{{name}}` and must be the same in every language.

`pnpm test` fails when a language is missing a key, has an empty value or uses different variables.

**Adding a language** (for example Portuguese):

1. Create `packages/i18n/src/locales/pt.json` with every key.
2. Add `"pt"` to `SUPPORTED_LOCALES`, `LOCALE_NATIVE_NAMES` and `INTL_TAGS` in `packages/i18n/src/index.ts`, and import the file into `resources`.
3. Register it in `apps/web/src/i18n/index.ts`.
4. Allow it in the `*_locale_check` constraints of `packages/db/src/schema.ts` and run `pnpm db:generate`.

### Events

Event types live in `packages/events/src/index.ts`. A new type needs a Zod payload schema and a label in both catalogs under `events.*`; a test checks the labels.

### Security

Never log or return a credential. Pass anything that may contain one through `redactSecrets` or `redactDeep` from `@infuture/vault`.

---

## Español

### Antes de abrir un pull request

```bash
pnpm check     # lint + tipos + tests
pnpm format
```

### Textos e idiomas

Todo texto que lee una persona vive en `packages/i18n/src/locales/en.json` y `es.json`. Nunca escribas textos fijos en componentes ni en respuestas de la API.

1. Añade la clave en `en.json` (define la forma del catálogo).
2. Añade la misma clave en `es.json`.
3. Úsala: `t("home.title")` en React, `request.t("home.title")` en la API, `translate(locale, "home.title")` en cualquier otro sitio.
4. Las variables usan `{{nombre}}` y deben ser las mismas en todos los idiomas.

`pnpm test` falla si a un idioma le falta una clave, tiene un valor vacío o usa variables distintas.

**Añadir un idioma** (por ejemplo, portugués):

1. Crea `packages/i18n/src/locales/pt.json` con todas las claves.
2. Añade `"pt"` a `SUPPORTED_LOCALES`, `LOCALE_NATIVE_NAMES` e `INTL_TAGS` en `packages/i18n/src/index.ts`, e importa el archivo en `resources`.
3. Regístralo en `apps/web/src/i18n/index.ts`.
4. Permítelo en las restricciones `*_locale_check` de `packages/db/src/schema.ts` y ejecuta `pnpm db:generate`.

### Eventos

Los tipos de evento viven en `packages/events/src/index.ts`. Un tipo nuevo necesita un esquema Zod para su payload y una etiqueta en ambos catálogos bajo `events.*`; un test verifica las etiquetas.

### Seguridad

Nunca registres ni devuelvas una credencial. Pasa todo lo que pueda contener una por `redactSecrets` o `redactDeep` de `@infuture/vault`.
