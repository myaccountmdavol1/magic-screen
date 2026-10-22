import type { ButtonHTMLAttributes, MouseEvent } from 'react'
import { playSound } from '../lib/sound'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'success' | 'record' | 'danger' | 'magic'
export type ButtonSize = 'md' | 'lg' | 'xl'

export type ButtonProps = {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  iconRight?: IconName
} & ButtonHTMLAttributes<HTMLButtonElement>

const ICON_PX: Record<ButtonSize, number> = { md: 22, lg: 26, xl: 34 }

/** Talkline chunky 3D pill. Every tap gets a sound so pre-readers know it registered. */
export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  className,
  children,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    playSound('tap')
    onClick?.(e)
  }
  const cls = ['btn', `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(' ')
  return (
    <button type={type} className={cls} onClick={handleClick} {...rest}>
      {icon && <Icon name={icon} size={ICON_PX[size]} />}
      {children != null && children !== false && <span className="btn-label">{children}</span>}
      {iconRight && <Icon name={iconRight} size={ICON_PX[size]} />}
    </button>
  )
}
