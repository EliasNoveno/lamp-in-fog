const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 20,
});

const query = async (text, params) => {
    const start = Date.now();
    try {
        const result = await pool.query(text, params);
        const duration = Date.now() - start;
        if (duration > 100) {
            console.log(`⏱️ Slow query (${duration}ms): ${text.slice(0, 100)}...`);
        }
        return result;
    } catch (error) {
        console.error("Database error:", error);
        throw error;
    }
};

module.exports = { pool, query };
