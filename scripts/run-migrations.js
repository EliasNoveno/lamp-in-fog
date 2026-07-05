const fs = require("fs");
const path = require("path");
const { query } = require("../src/config/database");
require("dotenv").config();

async function runMigrations() {
    const migrationsDir = path.join(__dirname, "../migrations");
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();

    console.log(`📁 Found ${files.length} migration files`);

    for (const file of files) {
        console.log(`📝 Running migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
        try {
            await query(sql);
            console.log(`✅ Migration ${file} completed`);
        } catch (error) {
            console.error(`❌ Migration ${file} failed:`, error.message);
            process.exit(1);
        }
    }

    console.log("✅ All migrations completed");
    process.exit(0);
}

runMigrations();
