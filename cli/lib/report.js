// Tiny ANSI helpers + a consistent console reporting style. No dependencies.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export function heading(title) {
  console.log('\n' + c.bold(c.cyan('▌ ' + title)));
}

export function kv(label, value, { good, bad, warn } = {}) {
  let v = String(value);
  if (good) v = c.green(v);
  else if (bad) v = c.red(v);
  else if (warn) v = c.yellow(v);
  console.log('  ' + c.dim(label.padEnd(28)) + ' ' + v);
}

export function line(s = '') {
  console.log(s);
}

const SEVERITY = {
  high: (s) => c.red('● ' + s),
  medium: (s) => c.yellow('● ' + s),
  low: (s) => c.blue('● ' + s),
  info: (s) => c.gray('● ' + s),
};

export function recommendation(rec, idx) {
  const tag = (SEVERITY[rec.severity] || SEVERITY.info)(rec.severity.toUpperCase());
  console.log(`\n  ${c.bold(`${idx}.`)} ${c.bold(rec.title)}   [${tag}]`);
  if (rec.why) console.log('     ' + c.dim('why:  ') + rec.why);
  if (rec.how) console.log('     ' + c.dim('how:  ') + rec.how);
  if (rec.auto) console.log('     ' + c.dim('auto: ') + c.green(rec.auto));
}

export function ms(n) {
  if (n == null || Number.isNaN(n)) return 'n/a';
  return `${Math.round(n)} ms`;
}

export function bytes(n) {
  if (n == null) return 'n/a';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
