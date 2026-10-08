import { readJson, writeJson } from './storage.js';

export function createStore(file) {
  const load = () => readJson(file, { nextId: 1, notes: [] });
  const find = (data, id) => data.notes.find((note) => note.id === id);
  return {
    add(note) {
      const data = load();
      const saved = { id: data.nextId, text: note.text, done: false };
      data.nextId += 1;
      data.notes.push(saved);
      writeJson(file, data);
      return saved;
    },
    list() {
      return load().notes;
    },
    setDone(id) {
      const data = load();
      const note = find(data, id);
      if (!note) return false;
      note.done = true;
      writeJson(file, data);
      return true;
    },
    remove(id) {
      const data = load();
      const before = data.notes.length;
      data.notes = data.notes.filter((note) => note.id !== id);
      writeJson(file, data);
      return data.notes.length < before;
    },
  };
}
