import type { ButtonHTMLAttributes, AnchorHTMLAttributes } from 'react'

type Props = { variant?: 'primary' | 'ghost' | 'quiet'; size?: 'md' | 'lg' } &
  (ButtonHTMLAttributes<HTMLButtonElement> & AnchorHTMLAttributes<HTMLAnchorElement>)

const base = 'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-500 ease-[cubic-bezier(.16,1,.3,1)] active:scale-[0.98] select-none whitespace-nowrap'
const variants = {
  primary: 'bg-ink text-white hover:bg-black hover:shadow-[0_12px_28px_-12px_rgba(0,0,0,.45)]',
  ghost: 'bg-transparent text-ink border border-line hover:border-ink/40 hover:bg-white',
  quiet: 'bg-transparent text-ink-2 hover:text-ink underline-offset-4 hover:underline px-0',
}
const sizes = { md: 'h-11 px-5 text-[15px]', lg: 'h-13 px-7 text-[17px]' }

export default function Button({ variant = 'primary', size = 'md', className = '', href, ...rest }: Props) {
  const cls = `${base} ${variants[variant]} ${variant === 'quiet' ? '' : sizes[size]} ${className}`
  if (href) return <a href={href} className={cls} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} />
  return <button className={cls} {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)} />
}
