import type { ButtonHTMLAttributes, MouseEvent } from 'react'
import { playSound } from '../lib/sound'
import { Icon, type IconName } from './Icon'

export type IconButtonTone = 'white' | 'blue' | 'pink' | 'orange' | 'mint'

export type IconButtonProps = {
  icon: IconName
  /** Required: icon-only buttons need a spoken/screen-reader name. */
  label: string
  size?: 'md' | 'lg' | 'xl'
  tone?: IconButtonTone
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>

const ICON_PX = { md: 26, lg: 32, xl: 44 } as const

export function IconButton({
  icon,
  label,
  size = 'md',
  tone = 'white',
  className,
  onClick,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    playSound('tap')
    onClick?.(e)
  }
  const cls = ['icon-btn', `icon-btn-${size}`, `tone-${tone}`, className].filter(Boolean).join(' ')
  return (
    <button type={type} className={cls} aria-label={label} title={label} onClick={handleClick} {...rest}>
      <Icon name={icon} size={ICON_PX[size]} />
    </button>
  )
}
