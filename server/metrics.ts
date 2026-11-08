// A tiny Prometheus exporter (text format 0.0.4), so no dependency is needed.
type Labels = Record<string, string>;
interface Family { name: string; help: string; type: string; render: () => string[] | Promise<string[]> }

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmt = (l: Labels) => {
  const keys = Object.keys(l).sort();
  return keys.length ? `{${keys.map((k) => `${k}="${esc(l[k])}"`).join(',')}}` : '';
};

export function createMetrics() {
  const families: Family[] = [];

  function counter(name: string, help: string) {
    const series = new Map<string, { labels: Labels; n: number }>();
    families.push({ name, help, type: 'counter', render: () => [...series.values()].map((s) => `${name}${fmt(s.labels)} ${s.n}`) });
    return {
      inc(labels: Labels = {}, n = 1) {
        const key = fmt(labels);
        const e = series.get(key);
        if (e) e.n += n; else series.set(key, { labels, n });
      },
    };
  }

  // A value read at scrape time. Use type "counter" for values that only ever go up.
  function gauge(name: string, help: string, collect: () => number | Promise<number>, type: 'gauge' | 'counter' = 'gauge') {
    families.push({ name, help, type, render: async () => [`${name} ${await collect()}`] });
  }

  function histogram(name: string, help: string, buckets: number[]) {
    const series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
    families.push({
      name, help, type: 'histogram',
      render: () => [...series.values()].flatMap((s) => [
        ...buckets.map((b, i) => `${name}_bucket${fmt({ ...s.labels, le: String(b) })} ${s.counts[i]}`),
        `${name}_bucket${fmt({ ...s.labels, le: '+Inf' })} ${s.count}`,
        `${name}_sum${fmt(s.labels)} ${s.sum}`,
        `${name}_count${fmt(s.labels)} ${s.count}`,
      ]),
    });
    return {
      observe(labels: Labels, value: number) {
        const key = fmt(labels);
        let s = series.get(key);
        if (!s) { s = { labels, counts: buckets.map(() => 0), sum: 0, count: 0 }; series.set(key, s); }
        buckets.forEach((b, i) => { if (value <= b) s.counts[i]++; });
        s.sum += value;
        s.count++;
      },
    };
  }

  async function render(): Promise<string> {
    const out: string[] = [];
    for (const f of families) out.push(`# HELP ${f.name} ${f.help}`, `# TYPE ${f.name} ${f.type}`, ...(await f.render()));
    return out.join('\n') + '\n';
  }

  return { counter, gauge, histogram, render };
}
