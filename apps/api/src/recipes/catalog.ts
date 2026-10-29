export type RecipeDefinition = {
  id: string;
  names: Record<string, string>;
  descriptions: Record<string, string>;
  goalTemplate: Record<string, string>;
  defaultRole: string;
  multiagent: boolean;
  tags: string[];
};

export const BUILTIN_RECIPES: RecipeDefinition[] = [
  {
    id: "architecture_review",
    names: {
      en: "System Architecture Review",
      es: "Revisión de Arquitectura de Sistemas",
    },
    descriptions: {
      en: "Decompose a system into microservices, evaluate tradeoffs, and audit with cross-model review.",
      es: "Desglosa un sistema en microservicios, evalúa trade-offs y audita con revisión cruzada de modelos.",
    },
    goalTemplate: {
      en: "Analyze the architecture for an event-driven system handling 100k requests/sec. Include data storage choices, security boundaries, and resilience strategies.",
      es: "Analiza la arquitectura de un sistema basado en eventos que maneje 100k peticiones/seg. Incluye opciones de almacenamiento, perímetros de seguridad y resiliencia.",
    },
    defaultRole: "supervisor",
    multiagent: true,
    tags: ["architecture", "backend", "scalability"],
  },
  {
    id: "security_audit",
    names: {
      en: "Zero-Trust Security Audit",
      es: "Auditoría de Seguridad Zero-Trust",
    },
    descriptions: {
      en: "Audit API endpoints and data flows against OWASP Top 10 vulnerabilities.",
      es: "Audita endpoints de API y flujos de datos frente a vulnerabilidades OWASP Top 10.",
    },
    goalTemplate: {
      en: "Perform a comprehensive security audit of our REST and WebSocket APIs. Check authentication, secret handling, envelope encryption, and input sanitization.",
      es: "Realiza una auditoría completa de seguridad de nuestras APIs REST y WebSocket. Verifica autenticación, manejo de secretos, cifrado por sobre y saneamiento de entradas.",
    },
    defaultRole: "reviewer",
    multiagent: true,
    tags: ["security", "audit", "owasp"],
  },
  {
    id: "code_generation",
    names: {
      en: "Feature Implementation & Unit Tests",
      es: "Implementación de Funcionalidad y Tests",
    },
    descriptions: {
      en: "Design, implement, and generate unit tests for a new software capability.",
      es: "Diseña, implementa y genera tests unitarios para una nueva funcionalidad de software.",
    },
    goalTemplate: {
      en: "Design and implement a rate-limiting middleware supporting token bucket algorithm, Redis backend, and comprehensive test suite.",
      es: "Diseña e implementa un middleware de limitación de tasa (rate limiting) con algoritmo token bucket, backend Redis y suite completa de tests.",
    },
    defaultRole: "developer",
    multiagent: true,
    tags: ["development", "coding", "testing"],
  },
  {
    id: "market_intelligence",
    names: {
      en: "Market & Competitive Synthesis",
      es: "Inteligencia de Mercado y Competencia",
    },
    descriptions: {
      en: "Investigate industry landscape, synthesize competitor offerings, and highlight market opportunities.",
      es: "Investiga el panorama del sector, sintetiza competidores y destaca oportunidades de mercado.",
    },
    goalTemplate: {
      en: "Conduct a market research analysis comparing leading autonomous agent orchestration frameworks in 2026. Highlight differentiators and gaps.",
      es: "Lleva a cabo un análisis de investigación de mercado comparando los principales frameworks de agentes autónomos en 2026. Destaca diferenciadores y vacíos.",
    },
    defaultRole: "researcher",
    multiagent: true,
    tags: ["research", "market", "strategy"],
  },
  {
    id: "documentation_suite",
    names: {
      en: "API Documentation & Integration Guide",
      es: "Documentación de API y Guía de Integración",
    },
    descriptions: {
      en: "Generate polished developer documentation with request/response examples and SDK usage.",
      es: "Genera documentación técnica para desarrolladores con ejemplos de petición/respuesta y uso del SDK.",
    },
    goalTemplate: {
      en: "Create an OpenAPI-compliant developer guide with cURL and TypeScript examples for the infuture IA REST and Realtime WebSocket API.",
      es: "Crea una guía para desarrolladores compatible con OpenAPI con ejemplos en cURL y TypeScript para la API REST y WebSockets de infuture IA.",
    },
    defaultRole: "writer",
    multiagent: false,
    tags: ["docs", "api", "guides"],
  },
  {
    id: "data_analytics",
    names: {
      en: "Metrics & Cost Optimization",
      es: "Métricas y Optimización de Costes",
    },
    descriptions: {
      en: "Analyze execution metrics, token expenditures, and suggest cost reduction strategies.",
      es: "Analiza métricas de ejecución, consumo de tokens y sugiere estrategias de reducción de costes.",
    },
    goalTemplate: {
      en: "Analyze agent token usage and execution latencies across providers. Suggest optimal model routing rules to reduce costs by 40% without losing quality.",
      es: "Analiza el consumo de tokens y latencias de agentes entre proveedores. Sugiere reglas óptimas de enrutamiento de modelos para reducir costes un 40% sin perder calidad.",
    },
    defaultRole: "analyst",
    multiagent: false,
    tags: ["analytics", "costs", "optimization"],
  },
];
