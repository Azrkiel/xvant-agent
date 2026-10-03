// Splits one CSV line into its fields.
export function parseLine(line) {
  return line.split(',').map((field) => field.trim());
}
