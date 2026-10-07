export const API_PORT = Number(process.env.INTRICA_E2E_API_PORT ?? 3101);
export const UI_PORT = Number(process.env.INTRICA_E2E_UI_PORT ?? 5198);
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const UI_URL = `http://127.0.0.1:${UI_PORT}`;
export const ADMIN_URL = process.env.INTRICA_TEST_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
const database = new URL(ADMIN_URL);
database.pathname = "/intrica_e2e";
export const DATABASE_URL = database.href;
