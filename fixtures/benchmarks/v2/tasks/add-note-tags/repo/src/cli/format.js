// One listed note: "3 [ ] Buy milk".
export function formatNote(note) {
  return note.id + ' [' + (note.done ? 'x' : ' ') + '] ' + note.text;
}
