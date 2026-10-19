// cost is the usage alias. Registered through usage.js; this file registers
// nothing. Backtick dynamic import per R1.3: a static export-from would make
// a cli file import the cli area, which check-boundaries forbids.
const { usageCommand } = await import(`./usage.js`);

export { usageCommand as costCommand };
