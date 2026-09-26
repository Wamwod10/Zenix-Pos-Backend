export const assertDatabaseConnection = async (db) => {
  try {
    const result = await db.query("SELECT current_database() AS database, current_user AS user_name");
    return {
      database: result.rows[0]?.database || "",
      userName: result.rows[0]?.user_name || "",
    };
  } catch (cause) {
    const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
    throw new Error(
      `Database connection failed${code}. Check DATABASE_URL, the Neon production branch, pooled endpoint, and TLS settings.`,
      { cause },
    );
  }
};
