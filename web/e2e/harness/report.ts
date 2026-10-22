// Markdown rendering + before/after comparison for harness results. Node only.
import { METRIC_INFO, METRIC_KEYS, type FrameMetrics } from './metrics.ts'

export interface RunResult {
  id: string
  helper: string
  mode: string
  scored: number
  metrics: Record<keyof FrameMetrics, number | null>
  info: Record<string, unknown>
}

export interface TimingResult {
  id: string
  helper: string
  stage: string
  frames: number
  tier: string
  cpuMedian: number
  cpuP90: number
  syncMedian: number
  syncP90: number
  /** GPU time from a timer query (null if the extension is unavailable) */
  gpuMedian: number | null
  gpuP90: number | null
}

export interface Results {
  label: string
  date: string
  env: Record<string, unknown>
  options: Record<string, unknown>
  runs: RunResult[]
  timing: TimingResult[]
}

const fmt = (v: number | null | undefined, d: number) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d))

export function toMarkdown(r: Results): string {
  const out: string[] = []
  out.push(`# Keyer harness: ${r.label}`, '')
  out.push(`${r.date} · ${String(r.env.renderer ?? '?')} · ${String(r.options.size ?? '')} · warmup ${String(r.options.warmup)} frames · helper cadence ${String(r.options.cadence)}`, '')
  out.push('Lower is better for every column. Units: ' + METRIC_KEYS.map((k) => `${METRIC_INFO[k].label} ${METRIC_INFO[k].unit}`).join('; ') + '.', '')
  const helpers = [...new Set(r.runs.map((x) => x.helper))]
  for (const h of helpers) {
    out.push(`## Magic Helper: ${h}`, '')
    out.push(`| scenario | mode | ${METRIC_KEYS.map((k) => METRIC_INFO[k].label).join(' | ')} |`)
    out.push(`|---|---|${METRIC_KEYS.map(() => '---:').join('|')}|`)
    for (const run of r.runs.filter((x) => x.helper === h)) {
      out.push(`| ${run.id} | ${run.mode} | ${METRIC_KEYS.map((k) => fmt(run.metrics[k], METRIC_INFO[k].digits)).join(' | ')} |`)
    }
    out.push('')
  }
  if (r.timing.length) {
    out.push('## render() cost', '')
    out.push('cpu = main-thread time inside render(); gpu = timer-query GPU time of the frame; sync = render() + 1 px readPixels round trip (upper bound, includes readback latency).', '')
    out.push('| scenario | helper | stage | tier | cpu median ms | cpu p90 ms | gpu median ms | gpu p90 ms | sync median ms | sync p90 ms |')
    out.push('|---|---|---|---|---:|---:|---:|---:|---:|---:|')
    for (const t of r.timing) {
      out.push(`| ${t.id} | ${t.helper} | ${t.stage} | ${t.tier} | ${t.cpuMedian.toFixed(3)} | ${t.cpuP90.toFixed(3)} | ${fmt(t.gpuMedian, 3)} | ${fmt(t.gpuP90, 3)} | ${t.syncMedian.toFixed(2)} | ${t.syncP90.toFixed(2)} |`)
    }
    out.push('')
  }
  return out.join('\n')
}

/** Before/after table: one row per scenario x helper, "a → b (±%)" per metric. */
export function compareMarkdown(a: Results, b: Results): string {
  const out: string[] = [`# ${a.label} → ${b.label}`, '']
  out.push(`| scenario | helper | ${METRIC_KEYS.map((k) => METRIC_INFO[k].label).join(' | ')} |`)
  out.push(`|---|---|${METRIC_KEYS.map(() => '---:').join('|')}|`)
  for (const rb of b.runs) {
    const ra = a.runs.find((x) => x.id === rb.id && x.helper === rb.helper)
    if (!ra) continue
    const cells = METRIC_KEYS.map((k) => {
      const va = ra.metrics[k]
      const vb = rb.metrics[k]
      const d = METRIC_INFO[k].digits
      if (va === null || vb === null) return `${fmt(va, d)} → ${fmt(vb, d)}`
      const pct = va !== 0 ? ((vb - va) / Math.abs(va)) * 100 : vb === 0 ? 0 : Infinity
      const tag = Math.abs(pct) < 0.5 ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)`
      return `${fmt(va, d)} → ${fmt(vb, d)}${tag}`
    })
    out.push(`| ${rb.id} | ${rb.helper} | ${cells.join(' | ')} |`)
  }
  if (a.timing.length && b.timing.length) {
    out.push('', '| timing | cpu median ms | gpu median ms | sync median ms |', '|---|---:|---:|---:|')
    for (const tb of b.timing) {
      const ta = a.timing.find((x) => x.id === tb.id && x.helper === tb.helper && x.stage === tb.stage)
      if (ta)
        out.push(
          `| ${tb.id} ${tb.helper} ${tb.stage} | ${ta.cpuMedian.toFixed(3)} → ${tb.cpuMedian.toFixed(3)} | ${fmt(ta.gpuMedian, 3)} → ${fmt(tb.gpuMedian, 3)} | ${ta.syncMedian.toFixed(2)} → ${tb.syncMedian.toFixed(2)} |`,
        )
    }
  }
  return out.join('\n') + '\n'
}
