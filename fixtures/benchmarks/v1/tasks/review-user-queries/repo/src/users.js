// Looks up users for the admin page.
export function createUsers(db) {
  return {
    async findByName(name) {
      const rows = await db.query(
        "SELECT id, name FROM users WHERE name = '" + name + "'",
      );
      return rows;
    },
    async remove(id) {
      db.query('DELETE FROM users WHERE id = ?', [id]);
      return true;
    },
  };
}
