import type { ReactNode } from 'react'

/** Frosted-glass card that holds each screen's content. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={className ? `panel ${className}` : 'panel'}>{children}</section>
}
