'use strict';

function format(level, context, message, extra) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.padEnd(5)}] [${context}] ${message}`;
  if (extra !== undefined) return `${base} ${JSON.stringify(extra)}`;
  return base;
}

const logger = {
  info(context, message, extra) {
    console.log(format('INFO', context, message, extra));
  },
  warn(context, message, extra) {
    console.warn(format('WARN', context, message, extra));
  },
  error(context, message, extra) {
    console.error(format('ERROR', context, message, extra));
  },
};

module.exports = logger;
