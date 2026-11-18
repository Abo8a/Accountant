import { defineWorkspace } from 'vitest/config';

// Единый запуск тестов из корня (`npm test`): контракты и passport-core, фронтенд, затем пайплайн.
// backend/pipeline-api здесь нет намеренно: его тесты делят одну локальную базу PGlite (data/pgdata),
// которую нельзя открывать из нескольких процессов. В workspace число воркеров берётся из корня,
// и fileParallelism: false из backend/pipeline-api/vitest.config.ts не действует — RAG-тесты краснели.
// Поэтому `npm test` запускает пайплайн отдельно, из его папки (`npm test -w @passport/pipeline-api`).
export default defineWorkspace(['packages/*', 'frontend']);
