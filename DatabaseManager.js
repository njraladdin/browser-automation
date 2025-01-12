const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class DatabaseManager {
  constructor() {
    this.db = new sqlite3.Database(path.join(__dirname, 'app.db'));
    this.initDatabase();
  }

  initDatabase() {
    this.db.serialize(() => {
      // Create profiles table with proper ID
      this.db.run(`
        CREATE TABLE IF NOT EXISTS profiles (
          profile_id TEXT PRIMARY KEY,
          profile_username TEXT UNIQUE NOT NULL,
          gemini_api_key TEXT,
          created_at TEXT NOT NULL
        )
      `);

      // Create flows table with profile_id reference
      this.db.run(`
        CREATE TABLE IF NOT EXISTS flows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          FOREIGN KEY (profile_id) REFERENCES profiles (profile_id)
        )
      `);

      // Create steps table
      this.db.run(`
        CREATE TABLE IF NOT EXISTS steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          flow_id TEXT NOT NULL,
          instructions TEXT NOT NULL,
          code TEXT NOT NULL,
          order_index INTEGER NOT NULL,
          FOREIGN KEY (flow_id) REFERENCES flows (id)
        )
      `);
    });
  }

  // Helper to wrap db.run in a promise
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  // Helper to wrap db.get in a promise
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // Helper to wrap db.all in a promise
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}

module.exports = DatabaseManager; 