'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { Command } from 'cmdk'
import { Check, ChevronDown, Copy, Loader2, Search, X } from 'lucide-react'
import {
  Dialog as DialogPrimitive,
  DropdownMenu as MenuPrimitive,
  Popover as PopoverPrimitive,
  Select as SelectPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui'
import { type ComponentProps, type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { cn, initials } from '../lib/format'
import { ProblemArt } from './empty-art'

const buttonStyles = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-normal whitespace-nowrap transition-colors duration-150 select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-action text-action-ink hover:bg-action-hover',
        outline: 'border border-field bg-surface text-ink shadow-control hover:bg-soft',
        ghost: 'text-ink-2 hover:bg-soft hover:text-ink',
        danger: 'border border-field bg-surface text-danger-ink shadow-control hover:bg-danger-soft',
      },
      size: { sm: 'h-7 px-2 text-sm', md: 'h-9 px-4 text-base', icon: 'size-7 [&_svg]:size-4', iconMd: 'size-9' },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
)

export function Button({
  className,
  variant,
  size,
  loading,
  children,
  disabled,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonStyles> & { loading?: boolean }) {
  return (
    <button type="button" className={cn(buttonStyles({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  )
}

const fieldStyles =
  'w-full rounded-md border border-field bg-surface px-3 text-base text-ink placeholder:text-ink-3 shadow-control transition-colors duration-150 hover:border-ink-3 focus-visible:border-signal focus-visible:ring-[3px] focus-visible:ring-signal/25 focus-visible:outline-none disabled:opacity-50 aria-invalid:border-danger'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldStyles, 'h-9', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldStyles, 'min-h-20 resize-y py-2', className)} {...props} />
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string
  hint?: ReactNode
  error?: string
  children: ReactNode
  className?: string
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-sm text-ink">{label}</span>
      {children}
      {error ? <span className="text-xs text-danger-ink">{error}</span> : hint ? <span className="text-xs text-ink-2">{hint}</span> : null}
    </label>
  )
}

export interface Option {
  value: string
  label: string
  hint?: string
}

interface SelectProps {
  value: string | null | undefined
  onChange: (value: string) => void
  options: Option[]
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
}

const SEARCHABLE_FROM = 7

function matchesEveryWord(_value: string, search: string, keywords?: string[]): number {
  const text = (keywords ?? []).join(' ').toLowerCase()
  return search
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
    ? 1
    : 0
}

function SearchableSelect({ value, onChange, options, placeholder, disabled, className, id }: SelectProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value)
  return (
    // Modal for the same reason a native select is: a dialog behind it would otherwise swallow the wheel while the list scrolls.
    <PopoverPrimitive.Root modal open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        id={id}
        role="combobox"
        disabled={disabled}
        className={cn(fieldStyles, 'flex h-9 items-center justify-between gap-2 text-left', !selected && 'text-ink-3', className)}
      >
        <span className="truncate">{selected?.label ?? placeholder ?? 'Select'}</span>
        <ChevronDown className="size-4 shrink-0 text-ink-3" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            const content = event.currentTarget as HTMLElement
            requestAnimationFrame(() => content.querySelector('[cmdk-item][data-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
          }}
          className="z-50 flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-56 flex-col overflow-hidden rounded-lg border border-divider bg-surface shadow-overlay animate-in fade-in-0 zoom-in-98 duration-100"
        >
          <Command filter={matchesEveryWord} defaultValue={value ?? undefined} className="flex min-h-0 flex-col" loop>
            <div className="flex shrink-0 items-center gap-2 border-b border-divider px-3">
              <Search className="size-4 shrink-0 text-ink-3" />
              <Command.Input placeholder="Search" className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-3" />
            </div>
            <Command.List className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
              <Command.Empty className="px-2 py-3 text-sm text-ink-2">Nothing matches.</Command.Empty>
              {options.map((option) => (
                <Command.Item
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.hint ?? '']}
                  onSelect={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                  className="flex cursor-default items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[selected=true]:bg-soft"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.hint ? <span className="truncate text-xs text-ink-2">{option.hint}</span> : null}
                  </span>
                  {option.value === value ? <Check className="size-4 shrink-0 text-signal" /> : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

export function Select({ value, onChange, options, placeholder, disabled, className, id }: SelectProps) {
  if (options.length >= SEARCHABLE_FROM) return <SearchableSelect {...{ value, onChange, options, placeholder, disabled, className, id }} />
  return (
    <SelectPrimitive.Root value={value ?? undefined} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        className={cn(fieldStyles, 'flex h-9 items-center justify-between gap-2 text-left data-[placeholder]:text-ink-3', className)}
      >
        <span className="truncate">
          <SelectPrimitive.Value placeholder={placeholder ?? 'Select'} />
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-ink-3" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-divider bg-surface shadow-overlay animate-in fade-in-0 zoom-in-98 duration-100"
        >
          <SelectPrimitive.Viewport className="scroll-thin p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="relative flex cursor-default items-center justify-between gap-4 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-soft"
              >
                <span className="flex min-w-0 flex-col">
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  {option.hint ? <span className="truncate text-xs text-ink-2">{option.hint}</span> : null}
                </span>
                <SelectPrimitive.ItemIndicator>
                  <Check className="size-4 text-signal" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/** Bigger modals split in two so they fit on screen. They stack again on a phone. */
export function DialogColumns({ start, end, className }: { start: ReactNode; end: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 items-start gap-x-8 gap-y-5 md:grid-cols-2', className)}>
      <div className="flex min-w-0 flex-col gap-5">{start}</div>
      <div className="flex min-w-0 flex-col gap-5">{end}</div>
    </div>
  )
}

/** Stays in view while the body scrolls. The negative offset cancels the body's padding, which sticky positioning otherwise keeps clear. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="sticky -bottom-5 z-10 -mx-5 mt-5 -mb-5 flex justify-end gap-2 border-t border-divider bg-surface px-5 py-3">{children}</div>
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 animate-in fade-in-0 duration-150" />
        <DialogPrimitive.Content
          aria-describedby={description ? undefined : undefined}
          className={cn(
            'fixed top-[12vh] left-1/2 z-50 flex max-h-[80vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-lg border border-divider bg-surface shadow-overlay animate-in fade-in-0 zoom-in-98 duration-150',
            wide ? 'max-w-5xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 text-sm text-ink-2">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export const Menu = MenuPrimitive.Root
export const MenuTrigger = MenuPrimitive.Trigger

export function MenuContent({ className, align = 'start', ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={4}
        className={cn(
          'scroll-thin z-50 max-h-96 min-w-44 overflow-y-auto rounded-lg border border-divider bg-surface p-1 shadow-overlay animate-in fade-in-0 zoom-in-98 duration-100',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

export function MenuItem({ className, ...props }: ComponentProps<typeof MenuPrimitive.Item>) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-soft [&_svg]:size-4 [&_svg]:text-ink-2',
        className,
      )}
      {...props}
    />
  )
}

export function MenuCheckboxItem({ className, ...props }: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem
      className={cn(
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-soft [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3',
        className,
      )}
      {...props}
    />
  )
}

export const MenuRadioGroup = MenuPrimitive.RadioGroup

export function MenuRadioItem({ className, ...props }: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-soft [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3',
        className,
      )}
      {...props}
    />
  )
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-2 py-1 text-xs text-ink-3', className)} {...props} />
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="my-1 h-px bg-divider" />
}

export function Tooltip({
  label,
  children,
  side,
  hoverOnly,
}: {
  label: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** For a menu trigger: closing the menu hands focus back to it, which would leave the tooltip open with nothing pointing at it. */
  hoverOnly?: boolean
}) {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild onFocus={hoverOnly ? (event) => event.preventDefault() : undefined}>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={4}
          className="z-50 max-w-72 rounded-sm border border-divider bg-surface px-2 py-1 text-xs text-ink shadow-overlay animate-in fade-in-0 duration-100"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export const TooltipProvider = TooltipPrimitive.Provider

const chipStyles = cva('inline-flex h-5 max-w-full items-center gap-1 rounded-sm px-1.5 text-xs whitespace-nowrap [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'bg-soft text-ink-2',
      info: 'bg-selected text-ink',
      success: 'bg-success-soft text-success',
      warning: 'bg-warning-soft text-warning-ink',
      danger: 'bg-danger-soft text-danger-ink',
      outline: 'border border-divider text-ink-2',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export function Chip({ tone, className, ...props }: ComponentProps<'span'> & VariantProps<typeof chipStyles>) {
  return <span className={cn(chipStyles({ tone }), className)} {...props} />
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-divider bg-soft px-1 font-sans text-xs text-ink-2">
      {children}
    </kbd>
  )
}

const AVATAR_TONES = [
  'bg-[#dbeafe] text-[#1e40af]',
  'bg-[#dcfce7] text-[#166534]',
  'bg-[#fef3c7] text-[#92400e]',
  'bg-[#fce7f3] text-[#9d174d]',
  'bg-[#ede9fe] text-[#5b21b6]',
  'bg-[#e0f2fe] text-[#075985]',
  'bg-[#ffedd5] text-[#9a3412]',
]

export function Avatar({ name, agent, size = 20, className }: { name: string; agent?: boolean; size?: number; className?: string }) {
  const hash = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold',
        agent ? 'rounded-sm' : 'rounded-full',
        AVATAR_TONES[hash % AVATAR_TONES.length],
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-sm bg-soft', className)} />
}

export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="divide-y divide-divider">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-10 items-center gap-3 px-4">
          <Skeleton className="size-4" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className={index % 2 ? 'h-3 max-w-[60%] flex-1' : 'h-3 max-w-[80%] flex-1'} />
        </div>
      ))}
    </div>
  )
}

export function EmptyState({ art, title, children, action }: { art?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-10 text-center sm:py-14">
      {art ? <div className="mb-5 w-full max-w-60">{art}</div> : null}
      <h3 className="text-lg font-semibold">{title}</h3>
      {children ? <div className="mt-1 text-sm text-ink-2">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <EmptyState art={<ProblemArt />} title="This did not load" action={retry ? <Button onClick={retry}>Try again</Button> : undefined}>
      {error instanceof Error ? error.message : 'Something went wrong.'}
    </EmptyState>
  )
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      variant="ghost"
      size={label ? 'sm' : 'icon'}
      aria-label={label ?? 'Copy'}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => toast.error('Could not copy'),
        )
      }}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
      {label}
    </Button>
  )
}

export function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1 rounded-md border border-divider bg-softer py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{shown ? value : '•'.repeat(24)}</code>
        {secret ? (
          <Button variant="ghost" size="sm" onClick={() => setShown(!shown)}>
            {shown ? 'Hide' : 'Show'}
          </Button>
        ) : null}
        <CopyButton value={value} />
      </div>
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
}: {
  value: T
  onChange: (value: T) => void
  tabs: { value: T; label: string; count?: number }[]
  className?: string
}) {
  return (
    <div role="tablist" className={cn('flex items-center gap-0.5', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-sm px-2 text-sm whitespace-nowrap transition-colors duration-150',
            tab.value === value ? 'bg-soft text-ink' : 'text-ink-2 hover:bg-soft/60 hover:text-ink',
          )}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="text-xs text-ink-3">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-2.5', disabled && 'pointer-events-none opacity-50')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 rounded-sm accent-[var(--action)]"
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint ? <span className="block text-xs text-ink-2">{hint}</span> : null}
      </span>
    </label>
  )
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl border border-divider bg-surface', className)} {...props} />
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-ink-2">{children}</h2>
      {action}
    </div>
  )
}
