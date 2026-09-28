import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const { Pool, types } = pg;
types.setTypeParser(1082, (value) => value);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

export const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@localhost:5432/mkuyu_org";
// Single-tenant internal system, so the pool is deliberately kept open for the
// life of the process. An idle pool used to be torn down after a minute of no
// traffic, and the next sign-in paid for ~20 fresh handshakes plus a cold
// database (measured 5.7 s versus 30 ms once warm).
const POOL_SIZE = Number(process.env.DATABASE_POOL_SIZE || 20);
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: POOL_SIZE,
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
});

export function query(text, values = []) {
	return pool.query(text, values);
}

export async function queryOne(text, values = []) {
	const result = await query(text, values);
	return result.rows[0];
}

export async function queryMany(text, values = []) {
	const result = await query(text, values);
	return result.rows;
}

export async function withTransaction(work) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await work(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function closeDatabase() {
	await pool.end();
}

export default pool;