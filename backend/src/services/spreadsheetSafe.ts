/**
 * Spreadsheet formula injection: a CSV cell starting with = + - @ (or a tab or
 * carriage return) is read as a formula by Excel. A leading apostrophe makes it
 * plain text. Every CSV the site writes from people's answers goes through this.
 */
export const formulaSafe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
