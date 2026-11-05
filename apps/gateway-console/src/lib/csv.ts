/**
 * One CSV cell. Text a spreadsheet would read as a formula (=, +, -, @, or a
 * tab or carriage return first, after any spaces) gets a leading apostrophe,
 * so a seller's name in an export stays text; numbers are left as they are.
 */
export function csvCell(value: string | number): string {
  let text = String(value)
  if (typeof value === 'string' && /^\s*[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
